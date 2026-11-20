import {
  BoatSandboxError,
  type BoatSandboxMoveThreadInput,
  type BoatSandboxMoveThreadResult,
  type BoatSandboxSetupProjectInput,
  type BoatSandboxSetupProjectResult,
  type EnvironmentId,
  type ModelSelection,
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
  type Project,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { BoatManagedSandbox } from "./BoatConfig.ts";
import * as BoatSandboxes from "./BoatSandboxes.ts";

/** The names upstream's Add project dialog copies by default: env files people need on a new machine. */
const COPIED_FILE = /(^|\/)(?:\.env(?:\..+)?|\.envrc|\.dev\.vars)$/;
const COPIED_FILE_MAX_BYTES = 1024 * 1024;
const TRANSCRIPT_MAX_CHARS = 60_000;
const SETUP_TIMEOUT = "20 minutes";

interface Limits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Moves work from this environment to a boat sandbox it powers: a project's
 * checkout (`setupProject`) or a thread with its branch and uncommitted
 * changes (`moveThread`). Git and files go over SSH, never through `origin`;
 * T3 records go through the environment link.
 */
export class BoatWork extends Context.Service<
  BoatWork,
  {
    readonly setupProject: (
      input: BoatSandboxSetupProjectInput,
    ) => Effect.Effect<BoatSandboxSetupProjectResult, BoatSandboxError>;
    /** `fromOwnTurn`: the thread's own agent asked, so its running turn is the one moving it. */
    readonly moveThread: (
      input: BoatSandboxMoveThreadInput,
      options?: { readonly fromOwnTurn?: boolean },
    ) => Effect.Effect<BoatSandboxMoveThreadResult, BoatSandboxError>;
  }
>()("t3/boat/BoatWork") {}

const fail = (message: string) => new BoatSandboxError({ message });

const CapabilitiesTool = Tool.make("orchestrator_capabilities", {
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
});

const peerTools = [
  ProjectToolkit.tools.t3_project_list,
  ProjectToolkit.tools.t3_project_create,
  ProjectToolkit.tools.t3_thread_launch,
  CapabilitiesTool,
] as const;
const toolEncoders = new Map<
  string,
  (params: unknown) => Effect.Effect<unknown, Schema.SchemaError>
>(
  peerTools.map((tool) => [
    tool.name,
    Schema.encodeUnknownEffect(tool.parametersSchema as unknown as Schema.Encoder<unknown>),
  ]),
);
const encodeToolParams = (tool: Tool.Any, params: unknown) =>
  toolEncoders.get(tool.name)?.(params) ?? Effect.die(`BoatWork has no encoder for ${tool.name}.`);

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** SSH and HTTPS remotes of one GitHub repository clone the same; synora signs in over HTTPS. */
export function cloneUrl(remote: string): string {
  const scp = /^git@github\.com:(.+?)(?:\.git)?$/.exec(remote);
  if (scp) return `https://github.com/${scp[1]}.git`;
  const ssh = /^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/.exec(remote);
  if (ssh) return `https://github.com/${ssh[1]}.git`;
  return remote;
}

/**
 * The model the moved thread runs there: the same instance and model when the
 * sandbox has them, else the same instance's first model, else the first
 * provider there that can run a task.
 */
export function sandboxModelSelection(
  current: ModelSelection,
  providers: OrchestratorMcpCapabilitiesResult["providers"],
): ModelSelection | null {
  const same = providers.find((provider) => provider.providerInstanceId === current.instanceId);
  if (same !== undefined) {
    if (same.models.some((model) => model.id === current.model)) return current;
    const first = same.models[0];
    if (first !== undefined) return { instanceId: same.providerInstanceId, model: first.id };
  }
  for (const provider of providers) {
    const first = provider.models[0];
    if (provider.canRunChildTask && first !== undefined) {
      return { instanceId: provider.providerInstanceId, model: first.id };
    }
  }
  return null;
}

function repositoryName(remote: string): string {
  const last = remote.replace(/\/+$/, "").split(/[/:]/).at(-1) ?? "project";
  return last.replace(/\.git$/, "") || "project";
}

function branchSlug(branch: string): string {
  return branch.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "moved";
}

/**
 * The first message of the moved thread: what happened, then the conversation,
 * newest kept when it is too long.
 */
export function movedThreadPrompt(input: {
  readonly title: string;
  readonly fromLabel: string;
  readonly branch: string;
  readonly setupNote: string | null;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}): string {
  const turns = input.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map(
      (message) =>
        `### ${message.role === "user" ? "User" : "Assistant"}\n\n${message.text.trim()}`,
    );
  const kept: Array<string> = [];
  let size = 0;
  for (const turn of turns.toReversed()) {
    if (size + turn.length > TRANSCRIPT_MAX_CHARS && kept.length > 0) break;
    kept.unshift(
      turn.length > TRANSCRIPT_MAX_CHARS ? `${turn.slice(0, TRANSCRIPT_MAX_CHARS)}…` : turn,
    );
    size += turn.length;
  }
  const dropped = turns.length - kept.length;
  return [
    `This thread continues "${input.title}", moved here from ${input.fromLabel}.`,
    `This worktree is on \`${input.branch}\` with that checkout's uncommitted changes, still uncommitted.`,
    input.setupNote,
    "",
    `## Conversation so far${dropped > 0 ? ` (the ${dropped} earliest messages left out)` : ""}`,
    "",
    kept.join("\n\n"),
    "",
    "## Now",
    "",
    "Check `git status`, then continue the work from where the conversation stops. Don't redo finished steps.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const FIND_OR_CLONE_SCRIPT = `set -euo pipefail
url=$1 name=$2
dest="$HOME/projects/$name"
if [ -d "$dest/.git" ]; then
  echo existing
else
  mkdir -p "$HOME/projects"
  git clone --quiet "$url" "$dest"
  echo cloned
fi
echo "$dest"
`;

const SETUP_SCRIPT = `set -eo pipefail
export T3CODE_PROJECT_ROOT=$1 T3CODE_WORKTREE_PATH=$2 command=$3
cd "$2"
if [ -z "$command" ]; then
  if [ -f pnpm-lock.yaml ]; then command="pnpm install"
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then command="bun install"
  elif [ -f yarn.lock ]; then command="yarn install"
  elif [ -f package-lock.json ]; then command="npm install"
  fi
fi
[ -n "$command" ] || exit 0
echo "B4_SETUP:$command"
eval "$command"
`;

/** Tracked and untracked changes as a tree, through a throwaway index so the checkout's stays. */
export const SNAPSHOT_SCRIPT =
  'export GIT_INDEX_FILE="$1"; git read-tree HEAD && git add -A && git write-tree';

/** Branch and worktree from refs pushed under refs/b4/move/<id>; the changes land uncommitted. */
export const WORKTREE_SCRIPT = `set -euo pipefail
root=$1 wt=$2 branch=$3 id=$4
cd "$root"
head=$(git rev-parse "refs/b4/move/$id/head")
wip=$(git rev-parse "refs/b4/move/$id/wip")
if git show-ref --verify --quiet "refs/heads/$branch"; then
  if git merge-base --is-ancestor "refs/heads/$branch" "$head" && ! git worktree list --porcelain | grep -qx "branch refs/heads/$branch"; then
    git branch -f "$branch" "$head"
  else
    branch="$branch-moved-$id"
    git branch "$branch" "$head"
  fi
else
  git branch "$branch" "$head"
fi
mkdir -p "$(dirname "$wt")"
git worktree add --quiet "$wt" "$branch"
cd "$wt"
git read-tree -m -u "$head" "$wip"
git reset --quiet
git -C "$root" update-ref -d "refs/b4/move/$id/head"
git -C "$root" update-ref -d "refs/b4/move/$id/wip"
echo "$branch"
`;

/** Writes each file under the root unless it already exists there, and prints the written paths. */
export function writeMissingFilesScript(
  files: ReadonlyArray<{ readonly path: string; readonly base64: string }>,
): string {
  return [
    "set -euo pipefail",
    "root=$1",
    ...files.map(({ path, base64 }) => {
      const target = `"$root"/${shellQuote(path)}`;
      return `if [ ! -e ${target} ]; then mkdir -p "$(dirname ${target})"; printf %s ${shellQuote(base64)} | (umask 077 && base64 -d > ${target}); echo ${shellQuote(path)}; fi`;
    }),
    "",
  ].join("\n");
}

const make = Effect.gen(function* () {
  const sandboxes = yield* BoatSandboxes.BoatSandboxes;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const run = Effect.fn("BoatWork.run")(function* (
    what: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly cwd?: string; readonly stdin?: string; readonly timeout?: "20 minutes" },
  ) {
    const output = yield* runner
      .run({
        command,
        args,
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        timeout: options?.timeout ?? "2 minutes",
        outputMode: "truncate",
      })
      .pipe(Effect.mapError((cause) => fail(`${what} failed: ${cause.message}`)));
    if (output.code !== 0) {
      const detail = (output.stderr.trim() || output.stdout.trim())
        .split("\n")
        .slice(-8)
        .join("\n");
      return yield* fail(`${what} failed (exit ${output.code ?? "signal"}): ${detail}`);
    }
    return output.stdout;
  });

  const git = (what: string, cwd: string, args: ReadonlyArray<string>) =>
    run(what, "git", ["-C", cwd, ...args]).pipe(Effect.map((out) => out.trim()));

  const sshOptions = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

  const remote = (
    what: string,
    sandbox: BoatManagedSandbox,
    script: string,
    args: ReadonlyArray<string>,
    timeout?: "20 minutes",
  ) =>
    sandbox.ssh === undefined
      ? Effect.fail(fail(`${sandbox.label} has no \`ssh\` target in boat.json.`))
      : run(
          what,
          "ssh",
          [...sshOptions, sandbox.ssh, `bash -l -s -- ${args.map(shellQuote).join(" ")}`],
          { stdin: script, ...(timeout === undefined ? {} : { timeout }) },
        );

  const peerCall = Effect.fn("BoatWork.peerCall")(function* <T extends Tool.Any>(
    environmentId: EnvironmentId,
    tool: T,
    params: Omit<Tool.Parameters<T>, "environmentId">,
    limits: Limits,
  ) {
    const encoded = (yield* encodeToolParams(tool, params).pipe(
      Effect.mapError((cause) => fail(cause.message)),
    )) as Record<string, unknown>;
    return (yield* peers
      .call({
        environmentId,
        tool: tool.name,
        arguments: encoded,
        limits,
        success: tool.successSchema as unknown as Schema.Decoder<Tool.Success<T>>,
      })
      .pipe(
        Effect.mapError((cause: OrchestratorMcpFailure) =>
          fail(`${tool.name} there failed: ${cause.message}`),
        ),
      )) as Tool.Success<T>;
  });

  const requireSandbox = Effect.fn("BoatWork.requireSandbox")(function* (
    environmentId: EnvironmentId,
  ) {
    const sandbox = yield* sandboxes.sandboxFor(environmentId);
    if (Option.isNone(sandbox)) {
      return yield* fail(`Environment ${environmentId} is not a boat sandbox this server powers.`);
    }
    yield* sandboxes.ensureAwake(environmentId);
    return sandbox.value;
  });

  const requireProject = Effect.fn("BoatWork.requireProject")(function* (projectId: Project["id"]) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError((cause) => fail(cause.message)));
    if (Option.isNone(project)) return yield* fail("The project was not found.");
    return project.value;
  });

  /** Ignored env files under `cwd`, as relative paths with their contents. */
  const envFiles = Effect.fn("BoatWork.envFiles")(function* (cwd: string) {
    const listed = yield* git("Listing ignored files", cwd, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ":(glob)**/.env",
      ":(glob)**/.env.*",
      ":(glob)**/.envrc",
      ":(glob)**/.dev.vars",
    ]);
    const files: Array<{ path: string; base64: string }> = [];
    for (const relative of listed.split("\0").filter((entry) => COPIED_FILE.test(entry))) {
      const absolute = path.join(cwd, relative);
      const info = yield* fileSystem.stat(absolute).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      if (Number(info.value.size) > COPIED_FILE_MAX_BYTES) continue;
      const bytes = yield* fileSystem
        .readFile(absolute)
        .pipe(Effect.mapError((cause) => fail(`Reading ${relative} failed: ${cause.message}`)));
      files.push({ path: relative, base64: Base64.encode(bytes) });
    }
    return files;
  });

  const copyEnvFiles = Effect.fn("BoatWork.copyEnvFiles")(function* (
    sandbox: BoatManagedSandbox,
    from: string,
    to: string,
  ) {
    const files = yield* envFiles(from);
    if (files.length === 0) return [];
    const written = yield* remote(
      `Copying env files to ${sandbox.label}`,
      sandbox,
      writeMissingFilesScript(files),
      [to],
    );
    return written.split("\n").filter((line) => line.length > 0);
  });

  /** The setup that ran, or null; a failure is reported, not thrown, so the work still moves. */
  const runSetup = Effect.fn("BoatWork.runSetup")(function* (
    sandbox: BoatManagedSandbox,
    projectRoot: string,
    directory: string,
    command: string,
  ) {
    return yield* remote(
      `Setup on ${sandbox.label}`,
      sandbox,
      SETUP_SCRIPT,
      [projectRoot, directory, command],
      SETUP_TIMEOUT,
    ).pipe(
      Effect.map((out) => ({
        command: /^B4_SETUP:(.*)$/m.exec(out)?.[1] ?? null,
        error: null as string | null,
      })),
      Effect.catch((error) => Effect.succeed({ command: command || null, error: error.message })),
    );
  });

  const listRemoteProjects = Effect.fn("BoatWork.listRemoteProjects")(function* (
    environmentId: EnvironmentId,
    limits: Limits,
  ) {
    const found: Array<Project> = [];
    let cursor: number | undefined;
    do {
      const page = yield* peerCall(
        environmentId,
        ProjectToolkit.tools.t3_project_list,
        { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
        limits,
      );
      found.push(...page.projects);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return found;
  });

  const ensureProject = Effect.fn("BoatWork.ensureProject")(function* (
    sandbox: BoatManagedSandbox,
    local: Project,
    limits: Limits,
  ) {
    const origin = yield* git("Reading origin", local.workspaceRoot, [
      "remote",
      "get-url",
      "origin",
    ]);
    const canonicalKey = local.repositoryIdentity?.canonicalKey;
    const existing = (yield* listRemoteProjects(sandbox.environmentId, limits)).find(
      (project) =>
        project.deletedAt === null &&
        canonicalKey !== undefined &&
        project.repositoryIdentity?.canonicalKey === canonicalKey,
    );
    if (existing !== undefined) return { project: existing, cloned: false };
    const [state = "", workspaceRoot = ""] = (yield* remote(
      `Cloning on ${sandbox.label}`,
      sandbox,
      FIND_OR_CLONE_SCRIPT,
      [cloneUrl(origin), repositoryName(origin)],
      SETUP_TIMEOUT,
    ))
      .trim()
      .split("\n");
    const created = yield* peerCall(
      sandbox.environmentId,
      ProjectToolkit.tools.t3_project_create,
      { title: local.title, workspaceRoot },
      limits,
    );
    return { project: created, cloned: state === "cloned" };
  });

  const setupProject: BoatWork["Service"]["setupProject"] = Effect.fn("BoatWork.setupProject")(
    function* (input) {
      const sandbox = yield* requireSandbox(input.environmentId);
      const local = yield* requireProject(input.projectId);
      const limits: Limits = { runtimeMode: "full-access", interactionMode: "default" };
      const { project, cloned } = yield* ensureProject(sandbox, local, limits);
      const copiedFiles = yield* copyEnvFiles(sandbox, local.workspaceRoot, project.workspaceRoot);
      const setup = cloned
        ? yield* runSetup(sandbox, project.workspaceRoot, project.workspaceRoot, "")
        : { command: null, error: null };
      if (setup.error !== null) return yield* fail(`The project is there, but ${setup.error}`);
      return {
        environmentId: sandbox.environmentId,
        projectId: project.id,
        workspaceRoot: project.workspaceRoot,
        cloned,
        copiedFiles,
        setupCommand: setup.command,
      };
    },
  );

  const moveThread: BoatWork["Service"]["moveThread"] = Effect.fn("BoatWork.moveThread")(
    function* (input, options) {
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError((cause) => fail(cause.message)));
      if (shell === null) return yield* fail("The thread was not found.");
      if (
        options?.fromOwnTurn !== true &&
        (shell.activityRunStatus === "running" || shell.activityRunStatus === "starting")
      ) {
        return yield* fail("The thread is running. Stop or wait for its turn, then move it.");
      }
      const sandbox = yield* requireSandbox(input.environmentId);
      const local = yield* requireProject(shell.projectId);
      const limits: Limits = {
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
      };
      const cwd = shell.worktreePath ?? local.workspaceRoot;
      const { project } = yield* ensureProject(sandbox, local, limits);
      const { providers } = yield* peerCall(sandbox.environmentId, CapabilitiesTool, {}, limits);
      const modelSelection = sandboxModelSelection(shell.modelSelection, providers);
      if (modelSelection === null) {
        return yield* fail(`${sandbox.label} has no provider signed in that can run the thread.`);
      }

      const head = yield* git("Reading HEAD", cwd, ["rev-parse", "HEAD"]);
      const branch =
        (yield* git("Reading the branch", cwd, ["branch", "--show-current"])) ||
        `b4/moved-${head.slice(0, 8)}`;
      const indexFile = path.join(
        yield* fileSystem
          .makeTempDirectory({ prefix: "b4-move-" })
          .pipe(Effect.mapError((cause) => fail(cause.message))),
        "index",
      );
      const tree = (yield* run(
        "Snapshotting changes",
        "sh",
        ["-c", SNAPSHOT_SCRIPT, "sh", indexFile],
        { cwd },
      )).trim();
      const wip = yield* git("Recording changes", cwd, [
        "commit-tree",
        tree,
        "-p",
        head,
        "-m",
        "b4: moved changes",
      ]);
      const id = wip.slice(0, 10);
      yield* run(
        "Pushing to the sandbox",
        "git",
        [
          "-C",
          cwd,
          "-c",
          `core.sshCommand=ssh ${sshOptions.join(" ")}`,
          "push",
          "--quiet",
          "--no-verify",
          `ssh://${sandbox.ssh}${project.workspaceRoot}`,
          `${head}:refs/b4/move/${id}/head`,
          `${wip}:refs/b4/move/${id}/wip`,
        ],
        { timeout: SETUP_TIMEOUT },
      );

      const worktreesDir = sandbox.worktreesDir ?? "~/.b4-code/worktrees";
      const worktreeBase = worktreesDir.startsWith("~/")
        ? (yield* remote("Reading the sandbox home", sandbox, 'echo "$HOME"', [])).trim() +
          worktreesDir.slice(1)
        : worktreesDir;
      const worktreePath = `${worktreeBase}/${repositoryName(project.workspaceRoot)}/${branchSlug(branch)}-${id.slice(0, 6)}`;
      const remoteBranch = (yield* remote(
        `Creating the worktree on ${sandbox.label}`,
        sandbox,
        WORKTREE_SCRIPT,
        [project.workspaceRoot, worktreePath, branch, id],
      )).trim();

      yield* copyEnvFiles(sandbox, cwd, worktreePath);
      const setupCommand = project.scripts
        .filter((script) => script.runOnWorktreeCreate)
        .map((script) => script.command)
        .join(" && ");
      const setup = yield* runSetup(sandbox, project.workspaceRoot, worktreePath, setupCommand);

      const { messages } = yield* threads
        .getThreadRecords(input.threadId, ["messages"])
        .pipe(Effect.mapError((cause) => fail(cause.message)));
      const launched = yield* peerCall(
        sandbox.environmentId,
        ProjectToolkit.tools.t3_thread_launch,
        {
          projectId: project.id,
          modelSelection,
          title: shell.title,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          workspaceStrategy: { type: "existing_worktree", worktreePath, branch: remoteBranch },
          message: movedThreadPrompt({
            title: shell.title,
            fromLabel: (yield* environment.getDescriptor).label,
            branch: remoteBranch,
            setupNote:
              setup.error !== null
                ? `Setup (\`${setup.command ?? "install"}\`) failed there, so run it before building: ${setup.error}`
                : null,
            messages,
          }),
          clientRequestId: `b4-move-${id}`,
        },
        limits,
      );
      return {
        environmentId: sandbox.environmentId,
        threadId: launched.threadId,
        projectId: project.id,
        worktreePath,
        branch: remoteBranch,
      };
    },
  );

  return BoatWork.of({ setupProject, moveThread });
});

export const layer = Layer.effect(BoatWork, make);
