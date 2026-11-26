#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off globalTimers:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Builds and runs b4-code from a dedicated checkout: sync, deploy, deploy-result,
 * service, doctor, pair, signing, boat. fork/README.md covers each command and B4_* variable.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const home = NodePath.resolve(
  process.env.B4_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".b4-code"),
);
const serviceSettingsPath = NodePath.join(home, "service.json");
const buildRecordPath = NodePath.join(home, "build.json");
const serviceLogPath = NodePath.join(home, "logs/service.log");
// Each deploy's log, result, and launchd plist, named by its id.
const deploysDir = NodePath.join(home, "logs/deploys");
const deployCheckout = NodePath.join(home, "src");
const serverEntry = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");
const pinnedNodesDir = NodePath.join(home, "node");

// oxlint-disable-next-line t3code/no-global-process-runtime -- a standalone script has no Effect runtime to inject the host platform.
const isMac = NodeOS.platform() === "darwin";
// oxlint-disable-next-line t3code/no-global-process-runtime -- same as above.
const hostArch = NodeOS.arch() === "arm64" ? "arm64" : "x64";

const DESKTOP_APP_NAME = "B4 Code";
const SIGNING_IDENTITY = "b4code local";
const installedDesktopApp = `/Applications/${DESKTOP_APP_NAME}.app`;

// The rendered set in fork/icons that `deploy` copies over upstream's icons.
// terminal is a ready alternative. See fork/icons/render.ts.
const APP_ICON = "sticker";
// The desktop build reads the production assets. The server build stamps the
// development web icons into its bundled client.
const APP_ICON_TARGETS = {
  "macos-1024.png": ["assets/prod/black-macos-1024.png"],
  "favicon.ico": ["assets/prod/t3-black-web-favicon.ico", "assets/dev/blueprint-web-favicon.ico"],
  "favicon-16x16.png": [
    "assets/prod/t3-black-web-favicon-16x16.png",
    "assets/dev/blueprint-web-favicon-16x16.png",
  ],
  "favicon-32x32.png": [
    "assets/prod/t3-black-web-favicon-32x32.png",
    "assets/dev/blueprint-web-favicon-32x32.png",
  ],
  "apple-touch-180.png": [
    "assets/prod/t3-black-web-apple-touch-180.png",
    "assets/dev/blueprint-web-apple-touch-180.png",
  ],
} as const;

const LAUNCHD_LABEL = "dev.b4code.server";
const DEPLOY_JOB_LAUNCHD = "dev.b4code.deploy";
const DEPLOY_JOB_SYSTEMD = "b4-code-deploy";
// boatbox is a boat.dev sandbox that runs only while Bruno works, and SSH fails while it's stopped.
const LINUX_SSH_TARGETS: ReadonlyArray<{ target: string; boatSandbox?: string }> = [
  { target: "devbox" },
  { target: "synora@devbox" },
  { target: "synora@boatbox", boatSandbox: "boatbox" },
];
const BOAT_UP_STATES = new Set(["ready", "idle", "running"]);
const launchdPlistPath = NodePath.join(
  NodeOS.homedir(),
  "Library/LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
const systemdUnitPath = NodePath.join(NodeOS.homedir(), ".config/systemd/user/b4-code.service");

function parsePort(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    fail(`B4_PORT must be a port number, got "${raw}".`);
  }
  return value;
}

function fail(message: string): never {
  console.error(`b4: ${message}`);
  process.exit(1);
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly allowFailure?: boolean },
) {
  const result = NodeChildProcess.spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0 && options?.allowFailure !== true) {
    fail(`${command} ${args.join(" ")} exited with ${String(result.status ?? result.signal)}.`);
  }
  return result.status === 0;
}

function read(command: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function requireCleanMain() {
  if (read("git", ["branch", "--show-current"]) !== "main") fail("check out main first.");
  if (read("git", ["status", "--porcelain"]) !== "")
    fail("the working tree has uncommitted changes.");
}

function sync() {
  requireCleanMain();
  run("git", ["fetch", "--multiple", "upstream", "origin"]);
  run("git", ["rebase", "upstream/main"]);
  run("git", ["push", "--force-with-lease=main:origin/main", "origin", "main"]);
}

async function deploy() {
  // `reset --hard` below discards local changes, so it only runs in the checkout
  // reserved for deploys, never in one used for development.
  if (repoRoot !== deployCheckout) {
    fail(`deploy only runs from ${deployCheckout}; this checkout is ${repoRoot}.`);
  }
  if (read("git", ["branch", "--show-current"]) !== "main") fail("check out main first.");
  // The restart at the end kills any session the b4-code server hosts, along with
  // everything its provider started, so the deploy runs as a launchd or systemd job
  // that belongs to no session. Every deploy goes through that one job, which makes
  // the service manager what keeps two from running at once.
  const sessionHome = process.env.T3CODE_HOME;
  const inSession = sessionHome !== undefined && NodePath.resolve(sessionHome) === home;
  for (;;) {
    const id = startOrAttachDeploy();
    if (inSession)
      // A turn the restart cuts off mid-command is one the server resumes.
      console.log(
        "b4: waiting for it. The restart ends this turn and the server resumes it; then run `cd ~/.b4-code/src && node fork/b4.ts deploy-result` instead of deploying again.",
      );
    const record = await waitForDeploy(id, { stream: !inSession });
    // A deploy this one attached to, or a push during the build, can leave origin/main
    // ahead of what was built, so that commit gets a deploy of its own.
    if (record?.ok !== true || shippedLatest(id, record) !== "stale") return;
    process.exitCode = 0;
    console.log("b4: so this deploy ships origin/main next.");
  }
}

// Whether the deploy built what origin/main is now: "shipped" means exactly that. Anything
// else sets exit code 1. The waiting `deploy` follows up on "stale" itself; a session the
// restart cut off learns it from deploy-result.
function shippedLatest(id: string, record: DeployRecord): "current" | "stale" | "unverified" {
  const built = record.commit?.slice(0, 10) ?? "an unknown commit";
  const latest = remoteMainCommit();
  if (latest !== undefined && latest === record.commit) {
    console.log(`b4: deploy ${id} shipped ${latest}, the tip of origin/main.`);
    return "current";
  }
  process.exitCode = 1;
  if (latest === undefined) {
    console.error(
      `b4: deploy ${id} built ${built}, but origin/main couldn't be read to confirm it's the latest.`,
    );
    return "unverified";
  }
  console.error(
    `b4: deploy ${id} built ${built}, but origin/main is now ${latest.slice(0, 10)}; deploy again to ship it.`,
  );
  return "stale";
}

function remoteMainCommit(): string | undefined {
  const remote = NodeChildProcess.spawnSync("git", ["ls-remote", "origin", "refs/heads/main"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  return remote.status === 0 ? /^[0-9a-f]{40}/.exec(remote.stdout)?.[0] : undefined;
}

function startOrAttachDeploy(): string {
  let lastError = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    const running = runningDeployId();
    // A job that already wrote its result is only unloading; the next deploy is a new one.
    if (running !== undefined && readDeployRecord(running)?.finishedAt === undefined) {
      console.log(`b4: deploy ${running} is already running; waiting for it.`);
      return running;
    }
    if (running !== undefined) {
      lastError = `deploy ${running} finished but is still unloading`;
      sleep(500);
      continue;
    }
    clearExitedDeployJob();
    const id = `${Date.now()}-${process.pid}`;
    // Only one job can hold the label or unit name, so a deploy that loses a race to
    // start finds the winner on the next pass.
    const started = startDeployJob(id);
    if (started === true) {
      // Written here as well as by the job, so a run counts once it starts, even if
      // the job dies before writing anything.
      seedDeployRecord(id, new Date().toISOString());
      console.log(`b4: started deploy ${id}, log in ${deployFile(id, "log")}`);
      return id;
    }
    NodeFS.rmSync(deployFile(id, "plist"), { force: true });
    lastError = started;
    sleep(500);
  }
  return fail(`could neither start a deploy job nor find a running one: ${lastError}`);
}

function deployFile(id: string, extension: "log" | "json" | "plist"): string {
  return NodePath.join(deploysDir, `${id}.${extension}`);
}

// The job only needs what finds the build tools and the clone's remote.
function deployJobEnvironment(): ReadonlyArray<[string, string]> {
  const names = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "SSH_AUTH_SOCK", "NODE_OPTIONS"];
  const passed = Object.entries(process.env).flatMap(([name, value]): Array<[string, string]> =>
    value !== undefined && (names.includes(name) || name.startsWith("B4_")) ? [[name, value]] : [],
  );
  // Resolved here, since the job starts in the checkout, where a relative B4_HOME means
  // something else.
  return [...passed.filter(([name]) => name !== "B4_HOME"), ["B4_HOME", home]];
}

function deployJobTarget(): string {
  return `gui/${NodeOS.userInfo().uid}/${DEPLOY_JOB_LAUNCHD}`;
}

// True once the job started, or what the service manager said when it didn't.
function startDeployJob(id: string): true | string {
  NodeFS.mkdirSync(deploysDir, { recursive: true });
  const log = deployFile(id, "log");
  const program = [process.execPath, NodePath.join(repoRoot, "fork/b4.ts"), "__deployJob", id];
  if (isMac) {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${DEPLOY_JOB_LAUNCHD}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...program.map((argument) => `    <string>${xml(argument)}</string>`),
      "  </array>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      ...deployJobEnvironment().map(
        ([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`,
      ),
      "  </dict>",
      `  <key>WorkingDirectory</key><string>${xml(repoRoot)}</string>`,
      "  <key>RunAtLoad</key><true/>",
      `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
      // launchd's default of 256 open files is too few for `vp i` and the build, as for the server.
      "  <key>SoftResourceLimits</key>",
      "  <dict><key>NumberOfFiles</key><integer>10240</integer></dict>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    const plistPath = deployFile(id, "plist");
    NodeFS.writeFileSync(plistPath, plist);
    // Fails while the label is loaded, so two deploys never both start.
    return startResult(
      NodeChildProcess.spawnSync(
        "launchctl",
        ["bootstrap", `gui/${NodeOS.userInfo().uid}`, plistPath],
        { encoding: "utf8" },
      ),
    );
  }
  // Fails while a unit with this name exists, so two deploys never both start.
  return startResult(
    NodeChildProcess.spawnSync(
      "systemd-run",
      [
        "--user",
        `--unit=${DEPLOY_JOB_SYSTEMD}`,
        "--collect",
        "--quiet",
        // Type=exec reports a missing executable here, not later; the property predates --service-type.
        "--property=Type=exec",
        "--property=LimitNOFILE=10240",
        `--property=WorkingDirectory=${repoRoot}`,
        `--property=StandardOutput=append:${log}`,
        `--property=StandardError=append:${log}`,
        ...deployJobEnvironment().map(([key, value]) => `--setenv=${key}=${value}`),
        "--",
        ...program,
      ],
      { encoding: "utf8" },
    ),
  );
}

function startResult(result: NodeChildProcess.SpawnSyncReturns<string>): true | string {
  if (result.status === 0) return true;
  return result.error?.message ?? (result.stderr.trim() || `exited with ${String(result.status)}`);
}

// The id of the deploy job holding the label or unit name, read from its arguments.
function runningDeployId(): string | undefined {
  if (isMac) {
    const job = NodeChildProcess.spawnSync("launchctl", ["print", deployJobTarget()], {
      encoding: "utf8",
    });
    // An exited job stays loaded until it's booted out; clearExitedDeployJob does that.
    if (job.status !== 0 || /^\tstate = not running$/m.test(job.stdout)) return undefined;
    return /__deployJob\s+(\d+-\d+)/.exec(job.stdout)?.[1];
  }
  const shown = NodeChildProcess.spawnSync(
    "systemctl",
    ["--user", "show", DEPLOY_JOB_SYSTEMD, "-p", "ActiveState", "-p", "ExecStart"],
    { encoding: "utf8" },
  );
  if (shown.status !== 0) return undefined;
  const unit = shown.stdout;
  const state = /^ActiveState=(.*)$/m.exec(unit)?.[1];
  // is-active alone misses a unit that is still starting or stopping, which still holds its name.
  if (!["active", "activating", "deactivating", "reloading"].includes(state ?? ""))
    return undefined;
  return /__deployJob\s+(\d+-\d+)/.exec(unit)?.[1];
}

// A job boots itself out when it finishes, so an exited one left loaded was killed.
// Two deploys starting in the same instant after that could both clear it, and the
// second would stop the first's new job; only a crash leaves this state.
function clearExitedDeployJob() {
  if (!isMac) {
    NodeChildProcess.spawnSync("systemctl", ["--user", "reset-failed", DEPLOY_JOB_SYSTEMD], {
      stdio: "ignore",
    });
    return;
  }
  const target = deployJobTarget();
  const exited = () => {
    const job = NodeChildProcess.spawnSync("launchctl", ["print", target], { encoding: "utf8" });
    return job.status === 0 && /^\tstate = not running$/m.test(job.stdout);
  };
  if (!exited()) return;
  // Two deploys recovering at once are staggered by pid, and each looks again right
  // before booting out, so the later one sees the other's new job and leaves it.
  sleep(process.pid % 300);
  if (!exited()) return;
  NodeChildProcess.spawnSync("launchctl", ["bootout", target], { stdio: "ignore" });
  // As for the service: bootstrap fails until the booted-out job is gone.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      NodeChildProcess.spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status !== 0
    )
      break;
    sleep(200);
  }
}

// Runs as the launchd or systemd job, with its output going to the run's log.
function deployJob() {
  const id = process.argv[3] ?? fail("__deployJob needs an id.");
  const startedAt = new Date().toISOString();
  seedDeployRecord(id, startedAt);
  const environment = { ...process.env };
  delete environment.T3CODE_HOME;
  const deployed = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(repoRoot, "fork/b4.ts"), "__deploy"],
    { cwd: repoRoot, env: environment, stdio: "inherit" },
  );
  const head = NodeChildProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  writeDeployRecord(id, {
    startedAt,
    ...(head.status === 0 ? { commit: head.stdout.trim() } : {}),
    finishedAt: new Date().toISOString(),
    ok: deployed.status === 0,
    exit: String(deployed.status ?? deployed.signal ?? deployed.error?.message),
  });
  pruneDeploys();
  // Unloading the label lets the next deploy start without booting out a finished job.
  // On launchd that stops this process too, after the result is written.
  if (isMac) NodeChildProcess.spawnSync("launchctl", ["bootout", deployJobTarget()]);
}

// The deploy itself, inside the job.
function deployStep() {
  if (repoRoot !== deployCheckout) fail(`deploy only runs from ${deployCheckout}.`);
  // A boat sandbox's idle check counts this as work, so it does not stop mid-build.
  NodeFS.writeFileSync(NodePath.join(home, "boat-hold"), "");
  run("git", ["fetch", "origin"]);
  run("git", ["reset", "--hard", "origin/main"]);
  // The reset may have changed this script, so the rest runs from the new copy.
  run(process.execPath, [NodePath.join(repoRoot, "fork/b4.ts"), "__build"]);
}

function deployIds(): Array<string> {
  let names: Array<string> = [];
  try {
    names = NodeFS.readdirSync(deploysDir);
  } catch {}
  const ids = new Set(
    names.flatMap((name) => /^(\d+-\d+)\.(?:log|json|plist)$/.exec(name)?.[1] ?? []),
  );
  return [...ids].toSorted((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

function pruneDeploys() {
  for (const id of deployIds().slice(0, -10))
    for (const extension of ["log", "json", "plist"] as const)
      NodeFS.rmSync(deployFile(id, extension), { force: true });
}

interface DeployRecord {
  startedAt: string;
  /** What the checkout was at when the deploy finished. */
  commit?: string;
  finishedAt?: string;
  ok?: boolean;
  exit?: string;
}

function writeDeployRecord(id: string, record: DeployRecord) {
  const path = deployFile(id, "json");
  const staged = `${path}.${process.pid}`;
  NodeFS.writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`);
  NodeFS.renameSync(staged, path);
}

// The starter and the job both seed a run's record, and either may come second, so the
// seed only creates it: it never replaces a result the job already wrote.
function seedDeployRecord(id: string, startedAt: string) {
  const path = deployFile(id, "json");
  const staged = `${path}.${process.pid}`;
  NodeFS.writeFileSync(staged, `${JSON.stringify({ startedAt }, null, 2)}\n`);
  try {
    NodeFS.linkSync(staged, path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    NodeFS.rmSync(staged, { force: true });
  }
}

function readDeployRecord(id: string): DeployRecord | undefined {
  let record: unknown;
  try {
    record = JSON.parse(NodeFS.readFileSync(deployFile(id, "json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  if (!("startedAt" in record) || typeof record.startedAt !== "string") return undefined;
  const { startedAt } = record;
  const commit =
    "commit" in record && typeof record.commit === "string" ? { commit: record.commit } : {};
  if (
    "finishedAt" in record &&
    typeof record.finishedAt === "string" &&
    "ok" in record &&
    typeof record.ok === "boolean" &&
    "exit" in record &&
    typeof record.exit === "string"
  )
    return {
      startedAt,
      ...commit,
      finishedAt: record.finishedAt,
      ok: record.ok,
      exit: record.exit,
    };
  return { startedAt };
}

// A job can take a moment to show as running and to write its first record, so only
// a stretch with neither the job nor a result counts as it dying.
// Undefined, with exit code 1, when the deploy died without a result.
async function waitForDeploy(
  id: string,
  options: { readonly stream: boolean },
): Promise<DeployRecord | undefined> {
  const log = deployFile(id, "log");
  let printed = 0;
  let goneSince: number | undefined;
  for (;;) {
    if (options.stream) printed = printLogFrom(log, printed);
    const record = readDeployRecord(id);
    if (record?.finishedAt !== undefined) {
      if (options.stream) printLogFrom(log, printed);
      reportDeploy(id, record, options);
      return record;
    }
    if (runningDeployId() === id) goneSince = undefined;
    else if ((goneSince ??= Date.now()) < Date.now() - 15_000) {
      // Not fail(): exiting at once can drop this line while stdout is a pipe.
      console.error(`b4: deploy ${id} stopped without a result; its log is ${log}.`);
      process.exitCode = 1;
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function printLogFrom(log: string, offset: number): number {
  let file: number;
  try {
    file = NodeFS.openSync(log, "r");
  } catch {
    return offset;
  }
  try {
    const length = NodeFS.fstatSync(file).size;
    if (length <= offset) return offset;
    const chunk = Buffer.alloc(length - offset);
    const read = NodeFS.readSync(file, chunk, 0, chunk.length, offset);
    process.stdout.write(chunk.subarray(0, read));
    return offset + read;
  } finally {
    NodeFS.closeSync(file);
  }
}

function reportDeploy(id: string, record: DeployRecord, options: { readonly stream: boolean }) {
  const log = deployFile(id, "log");
  let lines: Array<string> = [];
  // A streamed deploy already printed its log.
  if (!options.stream)
    try {
      const text = NodeFS.readFileSync(log, "utf8").trimEnd();
      if (text !== "") lines = text.split("\n");
    } catch {}
  if (record.ok === true) {
    if (!options.stream) {
      const answered = lines.findLast((line) => line.startsWith("b4: server answering on"));
      if (answered !== undefined) console.log(answered);
    }
    console.log(`b4: deploy ${id} built ${record.commit ?? "an unknown commit"}.`);
    return;
  }
  if (!options.stream && lines.length > 0) console.log(lines.slice(-40).join("\n"));
  // Not fail(): exiting at once can cut off the tail above while stdout is a pipe.
  console.error(`b4: deploy ${id} failed (${record.exit ?? "no exit"}); its log is ${log}.`);
  process.exitCode = 1;
}

// For an agent whose wait ended: waits on a running deploy, or reports the last one,
// or the one whose id it names.
async function deployResult() {
  const named = process.argv[3];
  if (named !== undefined) {
    if (readDeployRecord(named) === undefined) fail(`no deploy ${named} in ${deploysDir}.`);
    const record = await waitForDeploy(named, { stream: false });
    if (record?.ok === true) shippedLatest(named, record);
    return;
  }
  const running = runningDeployId();
  // A run counts once it wrote a record; a start that lost a race never does.
  const id =
    running ??
    deployIds()
      .filter((candidate) => NodeFS.existsSync(deployFile(candidate, "json")))
      .at(-1);
  if (id === undefined) fail(`no deploy has run from a job yet; see ${deploysDir}.`);
  let record = readDeployRecord(id);
  if (record?.finishedAt === undefined) {
    // One that just started may not show as running yet; the wait gives it time.
    console.log(`b4: deploy ${id} hasn't finished; waiting for it.`);
    record = await waitForDeploy(id, { stream: false });
  } else {
    console.log(
      `b4: deploy ${id} started at ${record.startedAt} and finished at ${record.finishedAt}.`,
    );
    reportDeploy(id, record, { stream: false });
  }
  if (record?.ok === true) shippedLatest(id, record);
}

function pinnedNodeVersion(): string {
  const manifest: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "package.json"), "utf8"),
  );
  const version =
    typeof manifest === "object" &&
    manifest !== null &&
    "engines" in manifest &&
    typeof manifest.engines === "object" &&
    manifest.engines !== null &&
    "node" in manifest.engines
      ? manifest.engines.node
      : undefined;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`package.json engines.node must be an exact version to pin, got ${String(version)}.`);
  }
  return `v${version}`;
}

function pinnedNodePath(): string {
  return NodePath.join(pinnedNodesDir, pinnedNodeVersion(), "bin/node");
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) fail(`${url} answered HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

// The server can't run on a package manager's Node: an upgrade deletes the binary
// under it, and on macOS that binary then loses ~/Documents access. nodejs.org's
// macOS builds also keep one signature across versions, so that grant should last.
async function installPinnedNode() {
  const version = pinnedNodeVersion();
  if (NodeFS.existsSync(pinnedNodePath())) return;
  const name = `node-${version}-${isMac ? "darwin" : "linux"}-${hostArch}`;
  const archive = `${name}.tar.gz`;
  const releaseUrl = `https://nodejs.org/dist/${version}`;
  console.log(`b4: installing Node ${version} in ${pinnedNodesDir}`);
  const sums = (await download(`${releaseUrl}/SHASUMS256.txt`)).toString("utf8");
  const expected = sums
    .split("\n")
    .find((line) => line.endsWith(`  ${archive}`))
    ?.split(" ")[0];
  if (expected === undefined) fail(`SHASUMS256.txt has no entry for ${archive}.`);
  const bytes = await download(`${releaseUrl}/${archive}`);
  const actual = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) fail(`${archive} has checksum ${actual}, expected ${expected}.`);

  NodeFS.mkdirSync(pinnedNodesDir, { recursive: true });
  const workDir = NodeFS.mkdtempSync(NodePath.join(pinnedNodesDir, ".install-"));
  const archivePath = NodePath.join(workDir, archive);
  NodeFS.writeFileSync(archivePath, bytes);
  run("tar", ["-xzf", archivePath, "-C", workDir]);
  NodeFS.renameSync(NodePath.join(workDir, name), NodePath.join(pinnedNodesDir, version));
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}

function removeOtherPinnedNodes() {
  const version = pinnedNodeVersion();
  for (const entry of NodeFS.readdirSync(pinnedNodesDir)) {
    if (entry !== version) {
      NodeFS.rmSync(NodePath.join(pinnedNodesDir, entry), { recursive: true, force: true });
    }
  }
}

async function build() {
  // The build runs on the Node that will run the server, so native modules match it.
  if (process.version !== pinnedNodeVersion()) {
    await installPinnedNode();
    const pinnedNode = pinnedNodePath();
    process.env.PATH = `${NodePath.dirname(pinnedNode)}:${process.env.PATH ?? ""}`;
    run(pinnedNode, [NodePath.join(repoRoot, "fork/b4.ts"), "__build"]);
    return;
  }
  // Branding is a packaging step, so main keeps upstream's code and tests. The
  // patch stays applied until the next deploy resets it, and it fails loudly
  // when an upstream sync moves the lines it touches.
  run("git", ["apply", "fork/branding.patch"]);
  applyAppIcon();
  raiseBuildHeap();
  run("vp", ["i"]);
  let desktopCommit = deployedBuild()?.desktopCommit;
  if (isMac && desktopNeedsBuild(desktopCommit)) {
    run("vp", ["run", "build:desktop"]);
    installDesktopApp();
    desktopCommit = read("git", ["rev-parse", "HEAD"]);
  } else {
    if (isMac)
      console.log(`b4: no client changes since ${desktopCommit?.slice(0, 10)}; keeping B4 Code.`);
    run("vp", ["run", "--filter", "t3", "build"]);
  }
  // doctor compares this with the pinned Node, since native modules only work on
  // the Node they were installed under.
  const buildRecord = {
    node: process.version,
    commit: read("git", ["rev-parse", "--short", "HEAD"]),
    ...(desktopCommit === undefined ? {} : { desktopCommit }),
  };
  NodeFS.writeFileSync(buildRecordPath, `${JSON.stringify(buildRecord, null, 2)}\n`);
  if (serviceInstalled()) {
    const restartedAt = Date.now();
    const saved = savedServiceSettings();
    if (saved === undefined) {
      restartService();
      console.log("b4: run `node fork/b4.ts service` once so deploys refresh the service.");
    } else installService(saved);
    await waitForServer(restartedAt);
    removeOtherPinnedNodes();
  } else console.log("b4: built. Run `node fork/b4.ts service` to start it in the background.");
}

// B4 Code bundles its own client and a copy of the server's build, so only server
// source and notes leave the installed app as it is. Anything else rebuilds it,
// including b4.ts, which picks the app icon.
function desktopNeedsBuild(builtFrom: string | undefined): boolean {
  if (builtFrom === undefined || !NodeFS.existsSync(installedDesktopApp)) return true;
  const diff = NodeChildProcess.spawnSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", builtFrom, "HEAD"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (diff.status !== 0) return true;
  return diff.stdout
    .split("\0")
    .filter((file) => file !== "")
    .some(
      (file) =>
        !file.startsWith("apps/server/src/") && !(file.startsWith("fork/") && file.endsWith(".md")),
    );
}

// `vp i` runs out of memory under Node's default heap on the Linux devbox, where
// the default is about 2 GB of its 7 GiB. 4096 MB is the value known to work.
// Children inherit process.env, so this reaches `vp i` and the builds after it.
// The Mac installs fine with its default heap, so it keeps it.
function raiseBuildHeap() {
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  if (isMac || /--max[-_]old[-_]space[-_]size/.test(nodeOptions)) return;
  process.env.NODE_OPTIONS = `${nodeOptions} --max-old-space-size=4096`.trim();
}

function applyAppIcon() {
  const iconDir = NodePath.join(repoRoot, "fork/icons", APP_ICON);
  for (const [file, targets] of Object.entries(APP_ICON_TARGETS)) {
    for (const target of targets) {
      const targetPath = NodePath.join(repoRoot, target);
      // Upstream renamed or moved it. Copying anyway would ship the T3 icon.
      if (!NodeFS.existsSync(targetPath)) fail(`${target} is missing; update APP_ICON_TARGETS.`);
      NodeFS.copyFileSync(NodePath.join(iconDir, file), targetPath);
    }
  }
}

function sleep(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function desktopAppRunning(): boolean {
  return (
    NodeChildProcess.spawnSync("pgrep", ["-x", DESKTOP_APP_NAME], { stdio: "ignore" }).status === 0
  );
}

function installDesktopApp() {
  const outputDir = NodePath.join(home, "desktop-build");
  NodeFS.rmSync(outputDir, { recursive: true, force: true });
  run(process.execPath, [
    "scripts/build-desktop-artifact.ts",
    "--platform",
    "mac",
    "--target",
    "zip",
    "--arch",
    hostArch,
    "--skip-build",
    "--output-dir",
    outputDir,
  ]);
  const archive = NodeFS.readdirSync(outputDir).find((name) => name.endsWith(".zip"));
  if (archive === undefined) fail(`no app archive in ${outputDir}.`);
  const unpacked = NodePath.join(outputDir, "unpacked");
  run("ditto", ["-x", "-k", NodePath.join(outputDir, archive), unpacked]);
  const builtApp = NodePath.join(unpacked, `${DESKTOP_APP_NAME}.app`);
  if (!NodeFS.existsSync(builtApp)) fail(`${builtApp} is missing from the archive.`);

  const firstInstall = !NodeFS.existsSync(installedDesktopApp);
  const wasRunning = desktopAppRunning();
  if (wasRunning) {
    run("osascript", ["-e", `tell application "${DESKTOP_APP_NAME}" to quit`]);
    for (let attempt = 0; attempt < 50 && desktopAppRunning(); attempt++) sleep(200);
    if (desktopAppRunning()) fail(`${DESKTOP_APP_NAME} did not quit; close it and deploy again.`);
  }
  NodeFS.rmSync(installedDesktopApp, { recursive: true, force: true });
  run("ditto", [builtApp, installedDesktopApp]);
  // A local build carries no quarantine flag, so Gatekeeper opens it either way.
  // The stable identity keeps the keychain's "Always Allow" valid across deploys;
  // an ad-hoc signature changes with every build and prompts again.
  const identity = signingIdentityExists() ? SIGNING_IDENTITY : "-";
  if (identity === "-")
    console.log("b4: no signing identity, signing ad-hoc. Run `node fork/b4.ts signing`.");
  run("codesign", ["--force", "--deep", "--sign", identity, installedDesktopApp]);

  // The app is a client of the server above. Starting with its local environment
  // off keeps it from running a second server the first time it opens.
  const settingsPath = NodePath.join(home, "desktop/userdata/desktop-settings.json");
  if (!NodeFS.existsSync(settingsPath)) {
    NodeFS.mkdirSync(NodePath.dirname(settingsPath), { recursive: true });
    NodeFS.writeFileSync(settingsPath, `${JSON.stringify({ localEnvironmentEnabled: false })}\n`);
  }
  // `open` passes this environment to the app, and T3CODE_HOME overrides the
  // app's own data home. A deploy run from a b4-code session has it set to the
  // server's home, which would point the app at the server's live database.
  delete process.env.T3CODE_HOME;
  if (firstInstall || wasRunning) run("open", [installedDesktopApp]);
  console.log(`b4: installed ${installedDesktopApp}`);
}

function serviceInstalled(): boolean {
  return NodeFS.existsSync(isMac ? launchdPlistPath : systemdUnitPath);
}

function restartService() {
  if (isMac) {
    run("launchctl", ["kickstart", "-k", `gui/${NodeOS.userInfo().uid}/${LAUNCHD_LABEL}`]);
  } else {
    run("systemctl", ["--user", "restart", "b4-code.service"]);
  }
  console.log("b4: restarted the service.");
}

// The deploy log's last line is how an agent whose session the restart ended
// learns that the server came back. The server records its address once it
// listens, which also covers a service installed with another B4_PORT or B4_HOST.
async function waitForServer(restartedAt: number) {
  const statePath = NodePath.join(home, "userdata/server-runtime.json");
  for (let attempt = 0; attempt < 120; attempt++) {
    const origin = restartedOrigin(statePath, restartedAt);
    const answered =
      origin !== undefined &&
      (await fetch(origin).then(
        (response) => response.ok,
        () => false,
      ));
    if (answered) {
      console.log(`b4: server answering on ${origin}`);
      return;
    }
    sleep(500);
  }
  fail(`the server did not come back within a minute; check its logs.`);
}

function restartedOrigin(statePath: string, restartedAt: number): string | undefined {
  let state: unknown;
  try {
    state = JSON.parse(NodeFS.readFileSync(statePath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof state !== "object" || state === null) return undefined;
  if (!("origin" in state) || typeof state.origin !== "string") return undefined;
  if (!("startedAt" in state) || typeof state.startedAt !== "string") return undefined;
  return Date.parse(state.startedAt) >= restartedAt ? state.origin : undefined;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

interface ServiceSettings {
  port: number;
  host: string;
  path: string;
}

// Deploys rewrite the service from these, since an ssh deploy carries neither
// B4_PORT and B4_HOST nor the PATH the service was installed with.
function savedServiceSettings(): ServiceSettings | undefined {
  let saved: unknown;
  try {
    saved = JSON.parse(NodeFS.readFileSync(serviceSettingsPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof saved !== "object" || saved === null) return undefined;
  if (!("port" in saved) || typeof saved.port !== "number") return undefined;
  if (!("host" in saved) || typeof saved.host !== "string") return undefined;
  if (!("path" in saved) || typeof saved.path !== "string") return undefined;
  return { port: parsePort(String(saved.port)), host: saved.host, path: saved.path };
}

function serviceSettingsFromShell(): ServiceSettings {
  const saved = savedServiceSettings();
  return {
    port: parsePort(process.env.B4_PORT?.trim() || String(saved?.port ?? 3780)),
    host: process.env.B4_HOST?.trim() || saved?.host || "127.0.0.1",
    // The service gets this shell's PATH so threads find node, claude, and codex.
    path: process.env.PATH ?? "/usr/bin:/bin",
  };
}

function serviceDefinition(settings: ServiceSettings): { path: string; text: string } {
  const program = [
    pinnedNodePath(),
    serverEntry,
    "serve",
    "--port",
    String(settings.port),
    "--host",
    settings.host,
  ];
  const environment = { T3CODE_HOME: home, PATH: settings.path };
  if (isMac) {
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...program.map((argument) => `    <string>${xml(argument)}</string>`),
      "  </array>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      ...Object.entries(environment).map(
        ([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`,
      ),
      "  </dict>",
      `  <key>WorkingDirectory</key><string>${xml(NodeOS.homedir())}</string>`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      // launchd's default of 256 open files runs out under the server's file watchers.
      "  <key>SoftResourceLimits</key>",
      "  <dict><key>NumberOfFiles</key><integer>10240</integer></dict>",
      `  <key>StandardOutPath</key><string>${xml(serviceLogPath)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(serviceLogPath)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    return { path: launchdPlistPath, text };
  }
  const text = [
    "[Unit]",
    "Description=b4-code server",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${program.map(systemdQuote).join(" ")}`,
    ...Object.entries(environment).map(
      ([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`,
    ),
    `WorkingDirectory=${NodeOS.homedir()}`,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return { path: systemdUnitPath, text };
}

function executableOfProcess(pid: string): string | undefined {
  if (!isMac) {
    try {
      return NodeFS.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
    } catch {
      return undefined;
    }
  }
  const files = NodeChildProcess.spawnSync("lsof", ["-a", "-p", pid, "-d", "txt", "-Fn"], {
    encoding: "utf8",
  });
  return /^n(.+)$/m.exec(files.stdout)?.[1];
}

function installService(settings: ServiceSettings) {
  if (!NodeFS.existsSync(serverEntry)) fail(`${serverEntry} is missing; run deploy first.`);
  if (!NodeFS.existsSync(pinnedNodePath()))
    fail(`${pinnedNodePath()} is missing; run deploy first.`);
  // The server logs a startup pairing token, so only this user may read the home.
  NodeFS.mkdirSync(NodePath.join(home, "logs"), { recursive: true });
  NodeFS.chmodSync(home, 0o700);
  NodeFS.writeFileSync(serviceSettingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const definition = serviceDefinition(settings);
  NodeFS.mkdirSync(NodePath.dirname(definition.path), { recursive: true });
  NodeFS.writeFileSync(definition.path, definition.text);
  const address = `http://${settings.host}:${settings.port}`;

  if (isMac) {
    const domain = `gui/${NodeOS.userInfo().uid}`;
    run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { allowFailure: true });
    // bootout returns before the old job is gone, and bootstrap fails until it is.
    for (let attempt = 0; attempt < 50; attempt++) {
      const loaded = NodeChildProcess.spawnSync(
        "launchctl",
        ["print", `${domain}/${LAUNCHD_LABEL}`],
        {
          stdio: "ignore",
        },
      );
      if (loaded.status !== 0) break;
      sleep(200);
    }
    run("launchctl", ["bootstrap", domain, launchdPlistPath]);
    console.log(`b4: running on ${address}, logs in ${serviceLogPath}`);
    return;
  }

  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "b4-code.service"]);
  run("systemctl", ["--user", "restart", "b4-code.service"]);
  console.log(`b4: running on ${address}, logs via journalctl --user -u b4-code`);
}

// Read-only. Run it when a client says the server did not answer.
async function doctor() {
  if (repoRoot !== deployCheckout) fail(`doctor only runs from ${deployCheckout}.`);
  let failed = false;
  const report = (status: "ok" | "warn" | "FAIL", label: string, detail: string) => {
    if (status === "FAIL") failed = true;
    console.log(`${status.padEnd(4)}  ${label}: ${detail}`);
  };

  const settings = savedServiceSettings();
  if (settings === undefined) {
    report("FAIL", "service.json", "missing or invalid; run `node fork/b4.ts service`");
  } else {
    report("ok", "service.json", `${settings.host}:${settings.port}`);
    const definition = serviceDefinition(settings);
    let installed: string | undefined;
    try {
      installed = NodeFS.readFileSync(definition.path, "utf8");
    } catch {
      installed = undefined;
    }
    if (installed === definition.text) report("ok", "service definition", definition.path);
    else
      report("FAIL", "service definition", `${definition.path} is out of date; deploy rewrites it`);

    const nodeVersion = pinnedNodeVersion();
    if (!NodeFS.existsSync(pinnedNodePath())) {
      report("FAIL", "node", `${pinnedNodePath()} is missing; redeploy`);
    } else {
      const built = deployedBuild();
      if (built === undefined) report("warn", "node", `${nodeVersion}; no build record yet`);
      else if (built.node !== nodeVersion) {
        report(
          "FAIL",
          "node",
          `${nodeVersion}, but ${built.commit} was built on ${built.node}; redeploy`,
        );
      } else report("ok", "node", `${nodeVersion}, running build ${built.commit}`);
    }

    for (const tool of ["claude", "codex"]) {
      const found = NodeChildProcess.spawnSync("/usr/bin/which", [tool], {
        env: { PATH: settings.path },
        encoding: "utf8",
      });
      if (found.status === 0) report("ok", tool, found.stdout.trim());
      else report("warn", tool, "not on the service's PATH");
    }
  }

  let serverPid: string | undefined;
  if (isMac) {
    const job = NodeChildProcess.spawnSync(
      "launchctl",
      ["print", `gui/${NodeOS.userInfo().uid}/${LAUNCHD_LABEL}`],
      { encoding: "utf8" },
    );
    const state = /^\tstate = (.+)$/m.exec(job.stdout)?.[1] ?? "not loaded";
    const lastExit = /last exit code = (.+)$/m.exec(job.stdout)?.[1] ?? "unknown";
    serverPid = /^\tpid = (\d+)$/m.exec(job.stdout)?.[1];
    report(state === "running" ? "ok" : "FAIL", "launchd job", `${state}, last exit ${lastExit}`);
  } else {
    const unit = NodeChildProcess.spawnSync(
      "systemctl",
      ["--user", "show", "b4-code.service", "-p", "ActiveState,SubState,ExecMainStatus,MainPID"],
      { encoding: "utf8" },
    );
    const fields = new Map(
      unit.stdout
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const active = fields.get("ActiveState") ?? "unknown";
    const detail = `${active} (${fields.get("SubState") ?? "?"}), last exit ${fields.get("ExecMainStatus") ?? "?"}`;
    report(active === "active" ? "ok" : "FAIL", "systemd unit", detail);
    const mainPid = fields.get("MainPID");
    serverPid = mainPid === undefined || mainPid === "0" ? undefined : mainPid;
  }

  // A service from before the pinned Node stays on its package manager's binary until
  // a deploy, and on macOS that binary loses ~/Documents access once an upgrade deletes it.
  if (serverPid !== undefined) {
    const running = executableOfProcess(serverPid);
    const expected = pinnedNodePath();
    const restart = isMac
      ? `launchctl kickstart -k gui/${NodeOS.userInfo().uid}/${LAUNCHD_LABEL}`
      : "systemctl --user restart b4-code.service";
    if (running === undefined) report("warn", "server node", `can't read pid ${serverPid}`);
    else if (!NodeFS.existsSync(running)) {
      report("FAIL", "server node", `${running} no longer exists; run \`${restart}\``);
    } else if (running !== expected) {
      report("FAIL", "server node", `${running}, not ${expected}; run \`${restart}\``);
    } else report("ok", "server node", running);
  }

  const origin =
    settings === undefined
      ? restartedOrigin(NodePath.join(home, "userdata/server-runtime.json"), 0)
      : `http://${settings.host}:${settings.port}`;
  if (origin === undefined) report("FAIL", "server", "no address to check");
  else {
    const answer = await fetch(`${origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(3000),
    }).then(
      (response) => `HTTP ${response.status}`,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    report(answer === "HTTP 200" ? "ok" : "FAIL", "server", `${origin} answered ${answer}`);
  }

  // A stack's cause lines carry no timestamp, so each takes its entry's.
  const recentErrors: Array<string> = [];
  let stamp = "?";
  for (const line of recentServiceLog()) {
    stamp = /^\[([\d:.]+)\]/.exec(line)?.[1] ?? stamp;
    if (!/\b(ERROR|FATAL)\b|EMFILE|EADDRINUSE|EPERM/.test(line)) continue;
    recentErrors.push(line.startsWith("[") ? line.trim() : `[${stamp}] ${line.trim()}`);
  }
  if (recentErrors.length === 0) report("ok", "recent log", "no errors");
  for (const line of recentErrors.slice(-3)) report("warn", "recent log", line.slice(0, 160));

  if (process.argv.includes("--all")) {
    if (!isMac) fail("--all runs from the Mac.");
    for (const { target, boatSandbox } of LINUX_SSH_TARGETS) {
      console.log(`\n${target}:`);
      if (boatSandbox !== undefined) {
        const state = boatSandboxState(boatSandbox);
        if (state === undefined || state === "error") {
          report(
            "FAIL",
            target,
            `boat sandbox ${boatSandbox} is ${state ?? "missing from `boat list`"}`,
          );
          continue;
        }
        if (!BOAT_UP_STATES.has(state)) {
          report("warn", target, `${state}, not checked`);
          continue;
        }
      }
      const remote = NodeChildProcess.spawnSync(
        "ssh",
        [target, "cd ~/.b4-code/src && node fork/b4.ts doctor"],
        { stdio: "inherit" },
      );
      if (remote.status === 0) report("ok", target, "doctor passed");
      else {
        const outcome = remote.error?.message ?? String(remote.status ?? remote.signal);
        report("FAIL", target, `doctor exited with ${outcome}`);
      }
    }
  }
  if (failed) process.exitCode = 1;
}

function recentServiceLog(): ReadonlyArray<string> {
  if (!isMac) {
    const journal = NodeChildProcess.spawnSync(
      "journalctl",
      ["--user", "-u", "b4-code", "-n", "400", "--no-pager", "-o", "cat"],
      { encoding: "utf8" },
    );
    return journal.stdout.split("\n");
  }
  try {
    const log = NodeFS.readFileSync(serviceLogPath, "utf8");
    return log.slice(-65536).split("\n");
  } catch {
    return [];
  }
}

function boatSandboxState(name: string): string | undefined {
  const listing = NodeChildProcess.spawnSync("boat", ["list", "--all", "--json", "--no-update"], {
    encoding: "utf8",
  });
  if (listing.status !== 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(listing.stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("sandboxes" in parsed)) return undefined;
  if (!Array.isArray(parsed.sandboxes)) return undefined;
  for (const sandbox of parsed.sandboxes) {
    if (typeof sandbox !== "object" || sandbox === null) continue;
    if (!("name" in sandbox) || sandbox.name !== name) continue;
    return "state" in sandbox && typeof sandbox.state === "string" ? sandbox.state : undefined;
  }
  return undefined;
}

function boatSandboxId(name: string): string {
  const listing = read("boat", ["list", "--all", "--json", "--no-update"]);
  const parsed: unknown = JSON.parse(listing);
  if (typeof parsed === "object" && parsed !== null && "sandboxes" in parsed) {
    const sandboxes: unknown = parsed.sandboxes;
    if (Array.isArray(sandboxes)) {
      for (const sandbox of sandboxes) {
        if (typeof sandbox !== "object" || sandbox === null) continue;
        if ("name" in sandbox && sandbox.name === name && "id" in sandbox) {
          if (typeof sandbox.id === "string") return sandbox.id;
        }
      }
    }
  }
  fail(`boat has no sandbox named ${name}.`);
}

/** A boat API key limited to one sandbox and `actions`; boat shows the secret only here. */
function createBoatKey(label: string, sandboxId: string, actions: ReadonlyArray<string>): string {
  const created = read("boat", [
    "api-key",
    "create",
    label,
    "--sandbox",
    sandboxId,
    "--actions",
    actions.join(","),
    "--ttl",
    "365d",
    "--json",
    "--no-update",
  ]);
  const parsed: unknown = JSON.parse(created);
  const secret =
    typeof parsed === "object" && parsed !== null && "secret" in parsed ? parsed.secret : undefined;
  if (typeof secret !== "string") fail("boat api-key create printed no key.");
  return secret;
}

/**
 * `boat configure <name> --url <sandbox server URL> --ssh <user@host>`, from the
 * Mac with the boat CLI signed in. Writes this server's boat.json, which powers
 * the sandbox, and the sandbox's, which stops it once it idles. The sandbox must
 * be running. See fork/README.md.
 */
async function boat() {
  const [action, name] = process.argv.slice(3);
  const flag = (key: string) => {
    const index = process.argv.indexOf(`--${key}`);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const url = flag("url")?.replace(/\/+$/, "");
  const ssh = flag("ssh");
  if (action !== "configure" || name === undefined || url === undefined || ssh === undefined) {
    fail(
      "usage: node fork/b4.ts boat configure <sandbox name> --url <server URL> --ssh <user@host>",
    );
  }
  const idleStopMinutes = Number(flag("idle-minutes") ?? "20");
  const sandboxId = boatSandboxId(name);
  const descriptor: unknown = await fetch(`${url}/.well-known/t3/environment`, {
    signal: AbortSignal.timeout(5000),
  }).then(
    (response) => response.json(),
    (error: unknown) =>
      fail(
        `${url} did not answer (${String(error)}). Resume ${name} with \`boat resume ${sandboxId}\`.`,
      ),
  );
  const environmentId =
    typeof descriptor === "object" && descriptor !== null && "environmentId" in descriptor
      ? descriptor.environmentId
      : undefined;
  if (typeof environmentId !== "string") fail(`${url} did not say which environment it is.`);

  const remote = NodeChildProcess.spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", ssh, "umask 077 && mkdir -p ~/.b4-code && cat > ~/.b4-code/boat.json"],
    {
      input: `${JSON.stringify(
        {
          apiKey: createBoatKey(`b4-${name}-self`, sandboxId, [
            "sandbox.read",
            "sandbox.update",
            "sandbox.stop",
          ]),
          self: { id: sandboxId, idleStopMinutes },
        },
        null,
        2,
      )}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (remote.status !== 0) fail(`writing boat.json on ${ssh} failed.`);

  // boat resumes onto a machine that booted before the disk arrived, so logind
  // never saw the account's linger flag and its user services, b4-code among
  // them, wait for the first login. A system unit starts them once the disk is in.
  const linger = NodeChildProcess.spawnSync("ssh", ["-o", "BatchMode=yes", ssh, "bash -s"], {
    input: [
      "set -euo pipefail",
      'unit="b4-linger-$(id -un).service"',
      'sudo tee "/etc/systemd/system/$unit" >/dev/null <<EOF',
      "[Unit]",
      "Description=Start $(id -un)'s user services once boat attaches the disk",
      "After=systemd-logind.service",
      "Wants=systemd-logind.service",
      "",
      "[Service]",
      "Type=oneshot",
      "ExecStart=/bin/systemctl start user@$(id -u).service",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "EOF",
      "sudo systemctl daemon-reload",
      'sudo systemctl enable "$unit"',
      "",
    ].join("\n"),
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (linger.status !== 0) fail(`installing the user-services unit on ${ssh} failed.`);

  const configPath = NodePath.join(home, "boat.json");
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) existing = { ...parsed };
  } catch {}
  const others = Array.isArray(existing.sandboxes)
    ? existing.sandboxes.filter(
        (entry: unknown) =>
          typeof entry !== "object" || entry === null || !("id" in entry) || entry.id !== sandboxId,
      )
    : [];
  const config = {
    ...existing,
    apiKey:
      typeof existing.apiKey === "string"
        ? existing.apiKey
        : createBoatKey(`b4-${NodeOS.hostname()}`, sandboxId, [
            "sandbox.read",
            "sandbox.update",
            "sandbox.stop",
            "sandbox.resume",
          ]),
    sandboxes: [...others, { id: sandboxId, environmentId, label: name, url, ssh }],
  };
  NodeFS.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `b4: ${configPath} powers ${name} (${environmentId}); ${ssh} stops it after ${idleStopMinutes} idle minutes.`,
  );
  console.log("b4: restart this server (deploy) so agents here list the sandbox tools.");
}

function deployedBuild(): { node: string; commit: string; desktopCommit?: string } | undefined {
  let built: unknown;
  try {
    built = JSON.parse(NodeFS.readFileSync(buildRecordPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof built !== "object" || built === null) return undefined;
  if (!("node" in built) || typeof built.node !== "string") return undefined;
  if (!("commit" in built) || typeof built.commit !== "string") return undefined;
  const desktopCommit =
    "desktopCommit" in built && typeof built.desktopCommit === "string"
      ? built.desktopCommit
      : undefined;
  return {
    node: built.node,
    commit: built.commit,
    ...(desktopCommit === undefined ? {} : { desktopCommit }),
  };
}

function signingIdentityExists(): boolean {
  const result = NodeChildProcess.spawnSync(
    "security",
    ["find-certificate", "-c", SIGNING_IDENTITY],
    {
      stdio: "ignore",
    },
  );
  return result.status === 0;
}

function createSigningIdentity() {
  if (!isMac) fail("the signing identity is macOS only.");
  if (signingIdentityExists()) {
    console.log(`b4: "${SIGNING_IDENTITY}" already exists in the login keychain.`);
    return;
  }
  const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "b4-signing-"));
  process.on("exit", () => NodeFS.rmSync(workDir, { recursive: true, force: true }));
  const file = (name: string) => NodePath.join(workDir, name);
  NodeFS.writeFileSync(
    file("openssl.cnf"),
    [
      "[req]",
      "distinguished_name = dn",
      "[dn]",
      "[codesign]",
      "basicConstraints = critical, CA:false",
      "keyUsage = critical, digitalSignature",
      "extendedKeyUsage = critical, codeSigning",
      "",
    ].join("\n"),
  );
  run("/usr/bin/openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "3650",
    "-subj",
    `/CN=${SIGNING_IDENTITY}`,
    "-config",
    file("openssl.cnf"),
    "-extensions",
    "codesign",
    "-keyout",
    file("key.pem"),
    "-out",
    file("cert.pem"),
  ]);
  // The bundle only carries the key into the keychain and is deleted on exit.
  const bundlePassword = NodeCrypto.randomBytes(16).toString("hex");
  run("/usr/bin/openssl", [
    "pkcs12",
    "-export",
    "-inkey",
    file("key.pem"),
    "-in",
    file("cert.pem"),
    "-out",
    file("identity.p12"),
    "-passout",
    `pass:${bundlePassword}`,
  ]);
  run("security", [
    "import",
    file("identity.p12"),
    "-k",
    NodePath.join(NodeOS.homedir(), "Library/Keychains/login.keychain-db"),
    "-P",
    bundlePassword,
    "-T",
    "/usr/bin/codesign",
  ]);
  console.log(`b4: created "${SIGNING_IDENTITY}". The next deploy signs B4 Code with it.`);
}

function pair() {
  run(pinnedNodePath(), [serverEntry, "pair", "--base-dir", home, ...process.argv.slice(3)]);
}

const commands: Record<string, () => void | Promise<void>> = {
  sync,
  deploy,
  "deploy-result": deployResult,
  __deployJob: deployJob,
  __deploy: deployStep,
  __build: build,
  service: () => installService(serviceSettingsFromShell()),
  doctor,
  pair,
  signing: createSigningIdentity,
  boat,
};
const command = commands[process.argv[2] ?? ""];
if (command === undefined)
  fail("usage: node fork/b4.ts <sync|deploy|deploy-result|service|doctor|pair|signing|boat>");
await command();
