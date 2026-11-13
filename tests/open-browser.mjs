// Exercise Pi's real opener with recording launchers; never open a real app.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { openBrowser } = await import(pathToFileURL(process.argv[2]));
const dir = mkdtempSync(join(tmpdir(), "pi-opener-"));
const saved = { ...process.env };
const argv = process.argv;
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const desktop = { DISPLAY: ":9", WAYLAND_DISPLAY: "wayland-test", XAUTHORITY: "/tmp/test auth", XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland", PATH: "/untrusted", UNRELATED: "do-not-import" };
try {
  writeFileSync(join(dir, "systemctl"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.RECORD + ".manager", "called"); if (process.env.MANAGER_FAIL) process.exit(1); console.log(${JSON.stringify(JSON.stringify(desktop))});\n`, { mode: 0o755 });
  writeFileSync(join(dir, "xdg-open"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.RECORD, JSON.stringify({args:process.argv.slice(2),env:process.env}));\n`, { mode: 0o755 });
  for (const scenario of ["missing", "existing", "unavailable", "file", "no-terminal", "rpc", "print", "json"]) {
    Object.assign(process.env, saved, { PATH: dir, RECORD: join(dir, scenario + ".json"), XDG_SESSION_TYPE: "tty" });
    for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "UNRELATED", "MANAGER_FAIL"]) delete process.env[name];
    if (scenario === "existing") Object.assign(process.env, { DISPLAY: ":42", XDG_CURRENT_DESKTOP: "custom" });
    if (scenario === "unavailable") process.env.MANAGER_FAIL = "1";
    Object.defineProperty(process.stdin, "isTTY", { value: scenario !== "no-terminal", configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: scenario !== "no-terminal", configurable: true });
    process.argv = argv.slice(0, 2);
    if (scenario === "rpc" || scenario === "json") process.argv.push("--mode", scenario);
    if (scenario === "print") process.argv.push("--print");
    process.env.REX_SESSION = "headless-inherited-marker";
    process.env.REX_BLOCK = "not-authority-to-open";
    const target = scenario === "file" ? "/tmp/my file;not-a-command.pdf" : "https://example.com/auth?a=1&b=$(not-a-command)";
    openBrowser(target);
    const deadline = Date.now() + 3000;
    while (!existsSync(process.env.RECORD) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(existsSync(process.env.RECORD), `launcher did not run: ${scenario}`);
    const result = JSON.parse(readFileSync(process.env.RECORD, "utf8"));
    assert.deepEqual(result.args, [target], "target is passed intact, without a shell");
    assert.equal(result.env.PATH, dir, "unrelated manager environment must not be imported");
    assert.equal(result.env.UNRELATED, undefined);
    if (scenario === "missing" || scenario === "file") {
      for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE"]) assert.equal(result.env[name], desktop[name]);
    } else if (scenario === "existing") {
      assert.equal(result.env.DISPLAY, ":42");
      assert.equal(result.env.XDG_CURRENT_DESKTOP, "custom");
    } else {
      assert.equal(result.env.DISPLAY, undefined, "headless fallback must not invent a display");
      if (scenario !== "unavailable") assert(!existsSync(process.env.RECORD + ".manager"), "headless sessions must not query the desktop environment");
    }
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
