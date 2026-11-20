// @effect-diagnostics nodeBuiltinImport:off -- Runs the move scripts against real git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  SNAPSHOT_SCRIPT,
  WORKTREE_SCRIPT,
  cloneUrl,
  movedThreadPrompt,
  sandboxModelSelection,
  writeMissingFilesScript,
} from "./BoatWork.ts";

const sh = (cwd: string, command: string, args: ReadonlyArray<string>, input?: string) =>
  NodeChildProcess.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trimEnd();

function tempDir() {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "b4-boat-"));
}

describe("moving a checkout", () => {
  it("lands the branch with its uncommitted, untracked, and deleted files uncommitted", () => {
    const root = tempDir();
    const local = NodePath.join(root, "local");
    const remote = NodePath.join(root, "remote");
    NodeFS.mkdirSync(local);
    sh(local, "git", ["init", "--quiet", "--initial-branch=main"]);
    NodeFS.writeFileSync(NodePath.join(local, "kept.txt"), "one\n");
    NodeFS.writeFileSync(NodePath.join(local, "gone.txt"), "bye\n");
    sh(local, "git", ["add", "."]);
    sh(local, "git", ["commit", "--quiet", "-m", "base"]);
    sh(root, "git", ["clone", "--quiet", local, remote]);
    sh(local, "git", ["checkout", "--quiet", "-b", "feature"]);
    NodeFS.writeFileSync(NodePath.join(local, "kept.txt"), "one\ntwo\n");
    NodeFS.rmSync(NodePath.join(local, "gone.txt"));
    NodeFS.writeFileSync(NodePath.join(local, "new.txt"), "fresh\n");
    const statusBefore = sh(local, "git", ["status", "--porcelain"]);

    const head = sh(local, "git", ["rev-parse", "HEAD"]);
    const tree = sh(local, "sh", ["-c", SNAPSHOT_SCRIPT, "sh", NodePath.join(root, "index")]);
    const wip = sh(local, "git", ["commit-tree", tree, "-p", head, "-m", "wip"]);
    sh(local, "git", [
      "push",
      "--quiet",
      remote,
      `${head}:refs/b4/move/x/head`,
      `${wip}:refs/b4/move/x/wip`,
    ]);
    const worktree = NodePath.join(root, "worktrees", "feature");
    const branch = sh(
      root,
      "bash",
      ["-s", "--", remote, worktree, "feature", "x"],
      WORKTREE_SCRIPT,
    );

    expect(branch).toBe("feature");
    expect(sh(local, "git", ["status", "--porcelain"])).toBe(statusBefore);
    expect(sh(worktree, "git", ["status", "--porcelain"]).split("\n").toSorted()).toEqual([
      " D gone.txt",
      " M kept.txt",
      "?? new.txt",
    ]);
    expect(NodeFS.readFileSync(NodePath.join(worktree, "kept.txt"), "utf8")).toBe("one\ntwo\n");
    expect(sh(remote, "git", ["for-each-ref", "refs/b4"])).toBe("");
  });

  it("keeps a sandbox branch that has moved on, under a new name", () => {
    const root = tempDir();
    const local = NodePath.join(root, "local");
    const remote = NodePath.join(root, "remote");
    NodeFS.mkdirSync(local);
    sh(local, "git", ["init", "--quiet", "--initial-branch=main"]);
    NodeFS.writeFileSync(NodePath.join(local, "a.txt"), "a\n");
    sh(local, "git", ["add", "."]);
    sh(local, "git", ["commit", "--quiet", "-m", "base"]);
    sh(root, "git", ["clone", "--quiet", local, remote]);
    sh(remote, "git", ["checkout", "--quiet", "-b", "feature"]);
    sh(remote, "git", ["commit", "--quiet", "--allow-empty", "-m", "sandbox work"]);
    sh(remote, "git", ["checkout", "--quiet", "main"]);
    const sandboxTip = sh(remote, "git", ["rev-parse", "feature"]);
    sh(local, "git", ["checkout", "--quiet", "-b", "feature"]);
    sh(local, "git", ["commit", "--quiet", "--allow-empty", "-m", "mac work"]);

    const head = sh(local, "git", ["rev-parse", "HEAD"]);
    const tree = sh(local, "sh", ["-c", SNAPSHOT_SCRIPT, "sh", NodePath.join(root, "index")]);
    const wip = sh(local, "git", ["commit-tree", tree, "-p", head, "-m", "wip"]);
    sh(local, "git", [
      "push",
      "--quiet",
      remote,
      `${head}:refs/b4/move/y/head`,
      `${wip}:refs/b4/move/y/wip`,
    ]);
    const branch = sh(
      root,
      "bash",
      ["-s", "--", remote, NodePath.join(root, "wt"), "feature", "y"],
      WORKTREE_SCRIPT,
    );

    expect(branch).toBe("feature-moved-y");
    expect(sh(remote, "git", ["rev-parse", "feature"])).toBe(sandboxTip);
    expect(sh(remote, "git", ["rev-parse", "feature-moved-y"])).toBe(head);
  });

  it("copies only files the target lacks", () => {
    const root = tempDir();
    NodeFS.mkdirSync(NodePath.join(root, "apps"));
    NodeFS.writeFileSync(NodePath.join(root, ".env"), "KEEP=theirs\n");
    const encode = (text: string) => Buffer.from(text).toString("base64");
    const written = sh(
      root,
      "bash",
      ["-s", "--", root],
      writeMissingFilesScript([
        { path: ".env", base64: encode("KEEP=ours\n") },
        { path: "apps/web/.env.local", base64: encode("A='b c'\n") },
      ]),
    );

    expect(written).toBe("apps/web/.env.local");
    expect(NodeFS.readFileSync(NodePath.join(root, ".env"), "utf8")).toBe("KEEP=theirs\n");
    expect(NodeFS.readFileSync(NodePath.join(root, "apps/web/.env.local"), "utf8")).toBe(
      "A='b c'\n",
    );
    expect(NodeFS.statSync(NodePath.join(root, "apps/web/.env.local")).mode & 0o777).toBe(0o600);
  });
});

describe("cloneUrl", () => {
  it.each([
    ["git@github.com:bjardon/b4code.git", "https://github.com/bjardon/b4code.git"],
    ["ssh://git@github.com/bjardon/b4code", "https://github.com/bjardon/b4code.git"],
    ["https://github.com/bjardon/b4code.git", "https://github.com/bjardon/b4code.git"],
    ["git@gitlab.com:a/b.git", "git@gitlab.com:a/b.git"],
  ])("%s", (remote, expected) => {
    expect(cloneUrl(remote)).toBe(expected);
  });
});

describe("movedThreadPrompt", () => {
  it("keeps the newest messages and says how many it left out", () => {
    const prompt = movedThreadPrompt({
      title: "Fix it",
      fromLabel: "Mac",
      branch: "feature",
      setupNote: null,
      messages: [
        { role: "user", text: "old ".repeat(20_000) },
        { role: "system", text: "hidden" },
        { role: "user", text: "newest ask" },
        { role: "assistant", text: "newest answer" },
      ],
    });

    expect(prompt).toContain("(the 1 earliest messages left out)");
    expect(prompt).toContain("### User\n\nnewest ask");
    expect(prompt).not.toContain("hidden");
    expect(prompt).not.toContain("old old");
  });
});

describe("sandboxModelSelection", () => {
  const provider = (id: string, models: ReadonlyArray<string>, canRunChildTask = true) =>
    ({
      providerInstanceId: id,
      driverKind: id,
      displayName: null,
      models: models.map((model) => ({ id: model })),
      canRunChildTask,
      canRunCrossProviderChildTask: true,
      constraints: [],
    }) as never;
  const current = { instanceId: "codex", model: "gpt-6" } as never;

  it.each([
    ["keeps the same instance and model", [provider("codex", ["x", "gpt-6"])], "codex/gpt-6"],
    ["takes the instance's first model", [provider("codex", ["x"])], "codex/x"],
    [
      "falls back to a provider that can run tasks",
      [provider("cursor", ["c"], false), provider("claude", ["opus"])],
      "claude/opus",
    ],
    ["has nothing to run", [provider("cursor", ["c"], false)], null],
  ] as const)("%s", (_name, providers, expected) => {
    const picked = sandboxModelSelection(current, providers);
    expect(picked === null ? null : `${picked.instanceId}/${picked.model}`).toBe(expected);
  });
});
