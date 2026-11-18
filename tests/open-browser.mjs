// Exercise Pi’s real click and shell paths without opening a desktop app.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const load = (path) => import(pathToFileURL(join(process.argv[2], path)));
const { openBrowser } = await load("pi-coding-agent/dist/utils/open-browser.js");
const { createLocalBashOperations } = await load("pi-coding-agent/dist/core/tools/bash.js");
const { TuiAltScreen, Markdown } = await load("pi-tui/dist/index.js");
const bash = createLocalBashOperations({ shellPath: process.argv[3] });
const dir = mkdtempSync(join(tmpdir(), "pi-opener-"));
const saved = { ...process.env };
const argv = process.argv;
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const desktop = { DISPLAY: ":9", WAYLAND_DISPLAY: "wayland-test", XAUTHORITY: "/tmp/test auth", XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland", KDE_SESSION_VERSION: "6", PATH: "/untrusted", UNRELATED: "do-not-import" };
function verifyLaunch(scenario, target) {
  const result = JSON.parse(readFileSync(process.env.RECORD, "utf8"));
  assert.deepEqual(result.args, [target], "target is passed intact");
  assert.notEqual(result.env.PATH, desktop.PATH, "manager PATH must not be imported");
  assert.equal(result.env.UNRELATED, undefined);
  if (scenario === "missing" || scenario === "file-click") {
    for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "KDE_SESSION_VERSION"]) {
      assert.equal(result.env[name], desktop[name], `${scenario}: missing ${name} needed by the desktop launcher`);
    }
  } else if (scenario === "existing") {
    assert.equal(result.env.DISPLAY, ":42");
    assert.equal(result.env.XDG_CURRENT_DESKTOP, "custom");
  } else {
    assert.equal(result.env.DISPLAY, undefined, "headless fallback must not invent a display");
  }
  if (!["missing", "file-click", "unavailable"].includes(scenario)) {
    assert(!existsSync(process.env.RECORD + ".manager"), `${scenario}: must not query the manager`);
  }
}
try {
  writeFileSync(join(dir, "systemctl"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.RECORD + ".manager", "called"); if (process.env.MANAGER_FAIL) process.exit(1); console.log(${JSON.stringify(JSON.stringify(desktop))});\n`, { mode: 0o755 });
  writeFileSync(join(dir, "xdg-open"), `#!${process.execPath}\nconst fs = require("node:fs"); const env = Object.fromEntries(${JSON.stringify(Object.keys(desktop))}.map(name => [name, process.env[name]])); fs.writeFileSync(process.env.RECORD + ".tmp", JSON.stringify({args:process.argv.slice(2),env})); fs.renameSync(process.env.RECORD + ".tmp", process.env.RECORD);\n`, { mode: 0o755 });
  for (const scenario of ["file-click", "missing", "existing", "unavailable", "no-terminal", "rpc", "print", "json"]) {
    Object.assign(process.env, saved, { PATH: dir, RECORD: join(dir, scenario + ".json"), XDG_SESSION_TYPE: "tty" });
    for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "KDE_SESSION_VERSION", "UNRELATED", "MANAGER_FAIL"]) delete process.env[name];
    if (scenario === "existing") Object.assign(process.env, { DISPLAY: ":42", XDG_CURRENT_DESKTOP: "custom" });
    if (scenario === "unavailable") process.env.MANAGER_FAIL = "1";
    Object.defineProperty(process.stdin, "isTTY", { value: scenario !== "no-terminal", configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: scenario !== "no-terminal", configurable: true });
    process.argv = argv.slice(0, 2);
    if (scenario === "rpc" || scenario === "json") process.argv.push("--mode", scenario);
    if (scenario === "print") process.argv.push("--print");
    process.env.REX_SESSION = "headless-inherited-marker";
    process.env.REX_BLOCK = "not-authority-to-open";
    process.env.TERM_PROGRAM = "rex";
    const target = scenario === "file-click" ? "file:///tmp/my%20folder/" : "https://example.com/auth?a=1&b=$(not-a-command)";
    if (scenario === "file-click") {
      const theme = Object.fromEntries([
        "heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet",
        "bold", "italic", "strikethrough", "underline",
      ].map((name) => [name, (text) => text]));
      const tui = new TuiAltScreen({ columns: 80, rows: 24, write() {} }, undefined, undefined, { openUrl: openBrowser });
      tui.previousScreen = new Markdown(`[Open folder](${target})`, 0, 0, theme).render(80);
      tui.handleViewportInput("\x1b[<16;1;1M");
      tui.handleViewportInput("\x1b[<16;1;1m");
    } else {
      openBrowser(target);
    }
    const deadline = Date.now() + 3000;
    while (!existsSync(process.env.RECORD) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(existsSync(process.env.RECORD), `launcher did not run: ${scenario}`);
    verifyLaunch(scenario, target);
    process.env.RECORD = join(dir, `${scenario}.shell.json`);
    const file = "file:///tmp/my%20folder/";
    const result = await bash.exec(`xdg-open "${file}"`, dir, { onData() {} });
    assert.equal(result.exitCode, 0, `${scenario}: shell launcher must run`);
    verifyLaunch(scenario, file);
  }
  console.log("PASS desktop environment recovery, existing display preservation, headless fallback, and associated URL/file dispatch");
} finally {
  process.argv = argv;
  for (const [stream, descriptor] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]]) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else delete stream.isTTY;
  }
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  rmSync(dir, { recursive: true, force: true });
}
