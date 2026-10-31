#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Builds and runs b4-code, Bruno's fork of T3 Code, from a dedicated checkout.
 * See fork/README.md for the layout and the first-time setup.
 *
 *   node fork/b4.ts sync      rebase main onto upstream/main and push it (dev checkout)
 *   node fork/b4.ts deploy    reset to origin/main, brand, build, restart; on macOS also
 *                             install the B4 Code desktop client (deploy checkout)
 *   node fork/b4.ts service   install or refresh the background service
 *   node fork/b4.ts doctor    check the service, its node, and the server (--all adds the devbox)
 *   node fork/b4.ts pair      print a one-time pairing link for a new client
 *   node fork/b4.ts signing   create the self-signed identity that signs B4 Code (macOS)
 *
 * B4_HOME (default ~/.b4-code), B4_PORT (3780), and B4_HOST (127.0.0.1) pick the
 * data directory and bind address. `service` saves the address and PATH in
 * B4_HOME/service.json, and later `service` and `deploy` runs reuse them. The
 * server runs on its own Node in B4_HOME/node, at the version package.json pins.
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
const deployCheckout = NodePath.join(home, "src");
const serverEntry = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");
const pinnedNodesDir = NodePath.join(home, "node");

// A standalone script with no Effect runtime to inject the host platform.
// oxlint-disable-next-line t3code/no-global-process-runtime
const isMac = NodeOS.platform() === "darwin";
// oxlint-disable-next-line t3code/no-global-process-runtime
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
const DEVBOX_SSH_HOST = "devbox";
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
  run("git", ["fetch", "upstream", "origin"]);
  run("git", ["rebase", "upstream/main"]);
  run("git", ["push", "--force-with-lease=main:origin/main", "origin", "main"]);
}

function deploy() {
  // `reset --hard` below discards local changes, so it only runs in the checkout
  // reserved for deploys, never in one used for development.
  if (repoRoot !== deployCheckout) {
    fail(`deploy only runs from ${deployCheckout}; this checkout is ${repoRoot}.`);
  }
  if (read("git", ["branch", "--show-current"]) !== "main") fail("check out main first.");
  // The restart at the end ends any session the b4-code server hosts, such as an
  // agent's. Run detached from it and log to a file the next session can read.
  const sessionHome = process.env.T3CODE_HOME;
  if (sessionHome !== undefined && NodePath.resolve(sessionHome) === home) {
    const logPath = NodePath.join(home, "logs/deploy.log");
    NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
    const log = NodeFS.openSync(logPath, "w");
    const environment = { ...process.env };
    delete environment.T3CODE_HOME;
    NodeChildProcess.spawn(process.execPath, [NodePath.join(repoRoot, "fork/b4.ts"), "deploy"], {
      cwd: repoRoot,
      detached: true,
      env: environment,
      stdio: ["ignore", log, log],
    }).unref();
    console.log(`b4: deploying in the background because the restart ends this session.`);
    console.log(`b4: log in ${logPath}`);
    return;
  }
  run("git", ["fetch", "origin"]);
  run("git", ["reset", "--hard", "origin/main"]);
  // The reset may have changed this script, so the rest runs from the new copy.
  run(process.execPath, [NodePath.join(repoRoot, "fork/b4.ts"), "__build"]);
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
  if (isMac) {
    run("vp", ["run", "build:desktop"]);
    installDesktopApp();
  } else {
    run("vp", ["run", "--filter", "t3", "build"]);
  }
  // doctor compares this with the pinned Node, since native modules only work on
  // the Node they were installed under.
  const buildRecord = {
    node: process.version,
    commit: read("git", ["rev-parse", "--short", "HEAD"]),
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
    // The service gets this shell's PATH so it finds node, claude, codex, and agent.
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

    for (const tool of ["claude", "codex", "agent"]) {
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
    console.log(`\n${DEVBOX_SSH_HOST}:`);
    const remote = NodeChildProcess.spawnSync(
      "ssh",
      [DEVBOX_SSH_HOST, "cd ~/.b4-code/src && node fork/b4.ts doctor"],
      { stdio: "inherit" },
    );
    if (remote.status !== 0) failed = true;
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

function deployedBuild(): { node: string; commit: string } | undefined {
  let built: unknown;
  try {
    built = JSON.parse(NodeFS.readFileSync(buildRecordPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof built !== "object" || built === null) return undefined;
  if (!("node" in built) || typeof built.node !== "string") return undefined;
  if (!("commit" in built) || typeof built.commit !== "string") return undefined;
  return { node: built.node, commit: built.commit };
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
  __build: build,
  service: () => installService(serviceSettingsFromShell()),
  doctor,
  pair,
  signing: createSigningIdentity,
};
const command = commands[process.argv[2] ?? ""];
if (command === undefined) fail("usage: node fork/b4.ts <sync|deploy|service|doctor|pair|signing>");
await command();
