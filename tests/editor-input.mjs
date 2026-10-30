import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const modules = process.argv[2];
const load = (path) => import(pathToFileURL(`${modules}/${path}`).href);
const { InteractiveMode } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js");
const { TuiMainScreen, TuiAltScreen, stripTerminalSequences, visibleWidth } = await load("@earendil-works/pi-tui/dist/index.js");
const { initTheme, getMarkdownTheme } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const { KeybindingsManager } = await load("@earendil-works/pi-coding-agent/dist/core/keybindings.js");
const bindings = new KeybindingsManager();
assert.deepEqual(bindings.getKeys("app.model.cycleForward"), ["shift+ctrl+p"]);
assert.ok(!bindings.getKeys("app.model.cycleBackward").includes("shift+ctrl+p"));
assert.ok(!bindings.getKeys("app.model.cycleForward").includes("ctrl+p"));
assert.deepEqual(bindings.getKeys("app.session.togglePath"), ["ctrl+p"]);
const { ExtensionRunner } = await load("@earendil-works/pi-coding-agent/dist/core/extensions/runner.js");
const permissionsShortcut = { extensionPath: "pi-permissions", description: "Open permissions", handler() {} };
const shortcutHost = { extensions: [{ shortcuts: new Map([["ctrl+p", permissionsShortcut]]) }], hasUI: () => true };
assert.equal(ExtensionRunner.prototype.getShortcuts.call(shortcutHost, bindings.getEffectiveConfig()).get("ctrl+p"), permissionsShortcut,
  "Ctrl+P must be available to permissions, despite picker-local Ctrl+P bindings");
const proto = InteractiveMode.prototype;
assert.equal(typeof proto.addExtensionEditorInputListener, "function", "editor-scoped input must be supported by the shipped runtime");

function component() {
  return {
    focused: false, inputs: [], text: "", actionHandlers: new Map(),
    render: () => [""], invalidate() {},
    handleInput(data) { this.inputs.push(data); },
    getText() { return this.text; }, setText(text) { this.text = text; },
  };
}

for (const Tui of [TuiMainScreen, TuiAltScreen]) {
  const tui = new Tui({
    columns: 100, rows: 30, kittyProtocolActive: true,
    start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {},
    hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  });
  tui.requestRender = () => {};
  let guide;
  const showOverlay = tui.showOverlay.bind(tui);
  tui.showOverlay = (component, options) => { guide = component; return showOverlay(component, options); };
  const editor = component();
  const mode = Object.assign(Object.create(proto), {
    extensionDialogs: [],
    ui: tui, editor, defaultEditor: editor,
    extensionEditorInputHandlers: new Set(), editorInputWrapped: new WeakSet(),
    extensionTerminalInputSubscriptions: new Set(),
    editorContainer: { clear() {}, addChild() {} }, disposeActiveSelector() {},
    getMarkdownThemeWithSettings: () => getMarkdownTheme(),
    getAppKeyDisplay: (key) => key, getEditorKeyDisplay: (key) => key,
    keybindings: { getEffectiveConfig: () => ({}) },
    runtimeHost: { session: { extensionRunner: { getShortcuts: () => new Map([["alt+j", { description: "Message another session" }], ["alt+m", { description: "Toggle minimap" }]]) } } },
  });
  const api = mode.createExtensionUIContext();
  const seen = [];
  const unsubscribe = api.onEditorInput((data) => {
    seen.push(data);
    return data === " " ? { consume: true } : { data: data.toUpperCase() };
  });
  tui.setFocus(editor);
  tui.handleTerminalInput(" ");
  assert.deepEqual(seen, [" "]);
  assert.deepEqual(editor.inputs, [], "consumed input must not reach the editor");
  tui.handleTerminalInput("a");
  assert.deepEqual(editor.inputs, ["A"], "transformed input reaches the original editor with its receiver intact");

  const dialog = component();
  tui.setFocus(dialog);
  tui.handleTerminalInput(" ");
  assert.deepEqual(dialog.inputs, [" "]);
  assert.equal(seen.length, 2, "a dialog must not trigger the prompt's voice gesture");
  tui.setFocus(editor);
  const overlay = component();
  const handle = tui.showOverlay(overlay);
  tui.handleTerminalInput(" ");
  assert.deepEqual(overlay.inputs, [" "]);
  assert.equal(seen.length, 2, "a focused overlay must not trigger voice");
  handle.hide();

  const removeModal = api.onTerminalInput(() => ({ consume: true }));
  tui.handleTerminalInput(" ");
  assert.equal(seen.length, 2, "even a later-registered raw-input modal gets priority over editor input");
  removeModal();

  const replacement = component();
  api.setEditorComponent(() => replacement);
  tui.handleTerminalInput(" ");
  assert.equal(seen.length, 3, "the hook follows custom editor replacement");
  assert.deepEqual(replacement.inputs, []);
  api.setEditorComponent(undefined);
  tui.handleTerminalInput(" ");
  assert.equal(seen.length, 4, "restoring an editor must not double-wrap input");

  unsubscribe();
  tui.handleTerminalInput(" ");
  assert.equal(seen.length, 4);
  assert.deepEqual(editor.inputs, ["A", " "]);
  api.onEditorInput(() => ({ consume: true }));
  mode.clearExtensionTerminalInputListeners();
  tui.handleTerminalInput(" ");
  assert.deepEqual(editor.inputs, ["A", " ", " "], "reload clears editor subscriptions too");
  assert.match(mode.getHotkeysMarkdown(), /Message another session/);
  assert.match(mode.getHotkeysMarkdown(), /Toggle minimap/);
  assert.match(mode.getHotkeysMarkdown(), /app.message.sendNow/);
  editor.text = "";
  const before = editor.inputs.length;
  tui.handleTerminalInput("?");
  assert.equal(tui.hasOverlay(), true, "empty-prompt ? opens the guide");
  assert.equal(editor.inputs.length, before, "the guide trigger is not inserted");
  const firstPage = guide.render(90);
  assert.match(firstPage.join("\n"), /Message another session/, "extension keys are visible on the first page");
  assert(firstPage.length <= tui.terminal.rows - 2);
  assert.match(stripTerminalSequences(firstPage[0]), /^╭.*╮$/, "help has a closed top border");
  assert.match(stripTerminalSequences(firstPage.at(-1)), /^╰.*╯$/, "help has a closed bottom border");
  for (const row of firstPage) assert.equal(visibleWidth(row), 90, "help covers the transcript across its full width");
  tui.handleTerminalInput("\x1b[F");
  assert.notDeepEqual(guide.render(90), firstPage, "the long guide scrolls to its last page");
  assert.match(guide.render(90).at(-2), /Esc closes/, "dismissal hint stays visible");
  tui.handleTerminalInput("\x1b[H");
  assert.deepEqual(guide.render(90), firstPage, "Home returns to the first page");
  // Fullscreen mouse dispatch hit-tests the last composited overlay bounds.
  tui.compositeOverlays([], tui.terminal.columns, tui.terminal.rows);
  tui.handleTerminalInput("\x1b[<65;30;12M");
  assert.notDeepEqual(guide.render(90), firstPage, "mouse wheel scrolls the focused guide");
  tui.handleTerminalInput("\x1b");
  assert.equal(tui.hasOverlay(), false, "Escape dismisses the guide");
  editor.text = "draft";
  tui.handleTerminalInput("?");
  assert.equal(tui.hasOverlay(), false);
  assert.equal(editor.inputs.at(-1), "?", "? remains literal in a draft");
  editor.text = "";
  tui.handleTerminalInput("\x1b[200~?\x1b[201~");
  assert.equal(tui.hasOverlay(), false, "pasting ? does not open help");
  tui.setFocus(dialog);
  tui.handleTerminalInput("?");
  assert.equal(tui.hasOverlay(), false, "questions in dialogs do not open help");
  tui.setFocus(editor);
  tui.handleTerminalInput("\x1b[63u");
  assert.equal(tui.hasOverlay(), true, "Kitty question-mark key opens help too");
  tui.handleTerminalInput("\x1b");
  tui.stop();
}
console.log("editor input: focus, overlays, raw modal priority, replacement, consumption, transforms and cleanup passed in both TUI modes");
