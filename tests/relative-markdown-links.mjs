import assert from "node:assert/strict";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const modules = process.argv[2];
const load = (path) => import(pathToFileURL(`${modules}/@earendil-works/${path}`).href);
const { InteractiveMode } = await load("pi-coding-agent/dist/modes/interactive/interactive-mode.js");
const { initTheme, getMarkdownTheme } = await load("pi-coding-agent/dist/modes/interactive/theme/theme.js");
const { Markdown, setCapabilityOverrides } = await load("pi-tui/dist/index.js");
initTheme("dark", false);
setCapabilityOverrides({ hyperlinks: true });

let cwd = "/work/A #1";
const mode = {
  sessionManager: { getCwd: () => cwd },
  settingsManager: { getCodeBlockIndent: () => 0 },
};
const getTheme = () => InteractiveMode.prototype.getMarkdownThemeWithSettings.call(mode);
const targets = (markdown, theme = getTheme()) => Array.from(
  new Markdown(markdown, 0, 0, theme).render(400).join("\n").matchAll(/\x1b\]8;;([^\x1b]+)\x1b\\/g),
  (match) => match[1],
);

const relative = "[Preview](.pi/todo/desktop-ui.ifYDZM4o/caption-dual.png)";
assert.deepEqual(targets(relative), ["file:///work/A%20%231/.pi/todo/desktop-ui.ifYDZM4o/caption-dual.png"]);
assert.deepEqual(targets("[Docs](../docs/with%20space%23.md#L5)"), ["file:///work/docs/with%20space%23.md#L5"]);
assert.deepEqual(targets("[Log](/tmp/log.txt)"), ["file:///tmp/log.txt"]);
assert.deepEqual(targets("[Home](~/Downloads)"), [pathToFileURL(`${homedir()}/Downloads`).href]);
assert.deepEqual(targets("[Authorize](https://auth.example/authorize?client_id=test)"), ["https://auth.example/authorize?client_id=test"]);
assert.deepEqual(targets("[Mail](mailto:foo@example.com) [File](file:///tmp/test) [Section](#usage) [Network](//example.org/file)"),
  ["mailto:foo@example.com", "file:///tmp/test", "#usage", "//example.org/file"]);
assert.deepEqual(targets("`[Code](./x)`\n\n```md\n[Code](./x)\n```"), []);
assert.deepEqual(targets("[Reference][docs]\n\n[docs]: ./README.md"), ["file:///work/A%20%231/README.md"]);
assert.deepEqual(targets(relative, getMarkdownTheme()), [".pi/todo/desktop-ui.ifYDZM4o/caption-dual.png"]);

const previous = getTheme();
cwd = "/other/session";
assert.deepEqual(targets("[New](README.md)"), ["file:///other/session/README.md"]);
assert.deepEqual(targets("[Old](README.md)", previous), ["file:///work/A%20%231/README.md"]);

setCapabilityOverrides({ hyperlinks: false });
assert.match(new Markdown("[Docs](./README.md)", 0, 0, getTheme()).render(100).join("\n"), /\(\.\/README\.md\)/);
console.log("PASS: Pi emits session-relative Markdown destinations as absolute file URLs");
