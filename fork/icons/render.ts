#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a maintainer tool with only Node built-ins.
/**
 * Renders an icon SVG in fork/icons into the PNG and ICO files that `deploy`
 * copies over upstream's brand assets. Needs Google Chrome and ImageMagick (macOS).
 *
 *   node fork/icons/render.ts sticker
 *
 * Each SVG's viewBox is the full-bleed icon body. The macOS export adds the
 * classic safe area (824 body inset 100 on a 1024 canvas) and a drop shadow,
 * like upstream's Icon Composer exports.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const chrome =
  process.env.CHROME?.trim() || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function fail(message: string): never {
  console.error(`render: ${message}`);
  process.exit(1);
}

function run(command: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} exited with ${String(result.status)}: ${result.stderr}`);
}

const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "b4-icon-"));

function screenshot(html: string, target: string) {
  const page = NodePath.join(tmp, "page.html");
  NodeFS.writeFileSync(page, html);
  run(chrome, [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--default-background-color=00000000",
    "--window-size=1024,1024",
    `--screenshot=${target}`,
    `file://${page}`,
  ]);
}

const name = process.argv[2];
if (name === undefined) fail("usage: node fork/icons/render.ts <icon name>");
const source = NodePath.join(import.meta.dirname, `${name}.svg`);
if (!NodeFS.existsSync(source)) fail(`${source} is missing.`);
const outDir = NodePath.join(import.meta.dirname, name);
NodeFS.mkdirSync(outDir, { recursive: true });

const page = (img: string) =>
  `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style>${img}`;

const full = NodePath.join(tmp, "full.png");
screenshot(page(`<img src="file://${source}" width="1024" height="1024">`), full);
screenshot(
  page(
    `<img src="file://${source}" width="824" height="824" style="margin:100px;filter:drop-shadow(0 8px 20px rgb(0 0 0 / .35))">`,
  ),
  NodePath.join(outDir, "macos-1024.png"),
);

const resize = (size: number, file: string) =>
  run("magick", [
    full,
    "-filter",
    "Lanczos",
    "-resize",
    `${size}x${size}`,
    NodePath.join(outDir, file),
  ]);
resize(180, "apple-touch-180.png");
resize(32, "favicon-32x32.png");
resize(16, "favicon-16x16.png");
run("magick", [
  full,
  "-define",
  "icon:auto-resize=256,128,64,48,32,24,16",
  NodePath.join(outDir, "favicon.ico"),
]);

NodeFS.rmSync(tmp, { recursive: true, force: true });
console.log(`render: wrote ${outDir}`);
