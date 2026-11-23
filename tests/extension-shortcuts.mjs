import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const modules = process.argv[2];
const load = (path) => import(pathToFileURL(`${modules}/${path}`));
const { ExtensionRunner } = await load("@earendil-works/pi-coding-agent/dist/core/extensions/runner.js");
const { KeybindingsManager } = await load("@earendil-works/pi-coding-agent/dist/core/keybindings.js");
const keys = new KeybindingsManager();
const shortcut = { description: "Open permissions", extensionPath: "pi-permissions", handler() {} };
const runner = Object.assign(Object.create(ExtensionRunner.prototype), {
  extensions: [{ shortcuts: new Map([["ctrl+p", shortcut]]) }],
  hasUI: () => true,
});
const bindings = keys.getResolvedBindings();
assert.equal(runner.getShortcuts(bindings).get("ctrl+p"), shortcut);
assert.deepEqual(runner.getShortcutDiagnostics(), [], "Picker-only Ctrl+P must not conflict with the editor extension");
assert(keys.matches("\x10", "app.models.toggleProvider"), "Provider picker retains Ctrl+P");
assert(keys.matches("\x10", "app.session.togglePath"), "Session picker retains Ctrl+P");
const reserved = { ...bindings, "app.model.select": "ctrl+p" };
assert(!runner.getShortcuts(reserved).has("ctrl+p"), "A real editor-global conflict must still block the extension");
assert(runner.getShortcutDiagnostics().length > 0);
console.log("Picker-only Ctrl+P coexistence and editor-global conflict protection passed");
