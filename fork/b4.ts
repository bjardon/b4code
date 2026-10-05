#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Builds and runs b4-code, Bruno's fork of T3 Code, from a dedicated checkout.
 * See fork/README.md for the layout and the first-time setup.
 *
 *   node fork/b4.ts sync      rebase main onto upstream/main and push it (dev checkout)
 *   node fork/b4.ts deploy    reset to origin/main, brand, build, restart; on macOS also
 *                             install the B4 Code desktop client (deploy checkout)
 *   node fork/b4.ts service   install or refresh the background service
 *   node fork/b4.ts pair      print a one-time pairing link for a new client
 *   node fork/b4.ts signing   create the self-signed identity that signs B4 Code (macOS)
 *
 * B4_HOME (default ~/.b4-code), B4_PORT (3780), and B4_HOST (127.0.0.1) pick the
 * data directory and bind address. `service` bakes them into the unit.
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
const port = parsePort(process.env.B4_PORT?.trim() || "3780");
const host = process.env.B4_HOST?.trim() || "127.0.0.1";
const serverEntry = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");

// A standalone script with no Effect runtime to inject the host platform.
// oxlint-disable-next-line t3code/no-global-process-runtime
const isMac = NodeOS.platform() === "darwin";
// oxlint-disable-next-line t3code/no-global-process-runtime
const macArch = NodeOS.arch() === "arm64" ? "arm64" : "x64";

const DESKTOP_APP_NAME = "B4 Code";
const SIGNING_IDENTITY = "b4code local";
const installedDesktopApp = `/Applications/${DESKTOP_APP_NAME}.app`;

const LAUNCHD_LABEL = "dev.b4code.server";
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
  const deployCheckout = NodePath.join(home, "src");
  if (repoRoot !== deployCheckout) {
    fail(`deploy only runs from ${deployCheckout}; this checkout is ${repoRoot}.`);
  }
  if (read("git", ["branch", "--show-current"]) !== "main") fail("check out main first.");
  run("git", ["fetch", "origin"]);
  run("git", ["reset", "--hard", "origin/main"]);
  // The reset may have changed this script, so the rest runs from the new copy.
  run(process.execPath, [NodePath.join(repoRoot, "fork/b4.ts"), "__build"]);
}

function build() {
  // Branding is a packaging step, so main keeps upstream's code and tests. The
  // patch stays applied until the next deploy resets it, and it fails loudly
  // when an upstream sync moves the lines it touches.
  run("git", ["apply", "fork/branding.patch"]);
  run("vp", ["i"]);
  if (isMac) {
    run("vp", ["run", "build:desktop"]);
    installDesktopApp();
  } else {
    run("vp", ["run", "--filter", "t3", "build"]);
  }
  if (serviceInstalled()) restartService();
  else console.log("b4: built. Run `node fork/b4.ts service` to start it in the background.");
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
    macArch,
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
  console.log(`b4: restarted on http://${host}:${port}`);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function installService() {
  if (!NodeFS.existsSync(serverEntry)) fail(`${serverEntry} is missing; run deploy first.`);
  const program = [process.execPath, serverEntry, "serve", "--port", String(port), "--host", host];
  // The service inherits this shell's PATH so it finds claude, codex, and agent.
  const environment = { T3CODE_HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" };
  // The server logs a startup pairing token, so only this user may read the home.
  NodeFS.mkdirSync(NodePath.join(home, "logs"), { recursive: true });
  NodeFS.chmodSync(home, 0o700);

  if (isMac) {
    const logPath = NodePath.join(home, "logs/service.log");
    const plist = [
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
      `  <key>StandardOutPath</key><string>${xml(logPath)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(logPath)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    NodeFS.mkdirSync(NodePath.dirname(launchdPlistPath), { recursive: true });
    NodeFS.writeFileSync(launchdPlistPath, plist);
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
    console.log(`b4: running on http://${host}:${port}, logs in ${logPath}`);
    return;
  }

  const unit = [
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
  NodeFS.mkdirSync(NodePath.dirname(systemdUnitPath), { recursive: true });
  NodeFS.writeFileSync(systemdUnitPath, unit);
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "b4-code.service"]);
  run("systemctl", ["--user", "restart", "b4-code.service"]);
  console.log(`b4: running on http://${host}:${port}, logs via journalctl --user -u b4-code`);
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
  run(process.execPath, [serverEntry, "pair", "--base-dir", home, ...process.argv.slice(3)]);
}

const commands: Record<string, () => void> = {
  sync,
  deploy,
  __build: build,
  service: installService,
  pair,
  signing: createSigningIdentity,
};
const command = commands[process.argv[2] ?? ""];
if (command === undefined) fail("usage: node fork/b4.ts <sync|deploy|service|pair|signing>");
command();
