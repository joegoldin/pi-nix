import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const modules = process.argv[2];
const load = (path) => import(pathToFileURL(`${modules}/${path}`).href);
const { InteractiveMode } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js");
const { TuiMainScreen, TuiAltScreen } = await load("@earendil-works/pi-tui/dist/index.js");
const { initTheme } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
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
  const editor = component();
  const mode = Object.assign(Object.create(proto), {
    ui: tui, editor, defaultEditor: editor,
    extensionEditorInputHandlers: new Set(), editorInputWrapped: new WeakSet(),
    extensionTerminalInputSubscriptions: new Set(),
    editorContainer: { clear() {}, addChild() {} }, disposeActiveSelector() {},
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
  tui.stop();
}
console.log("editor input: focus, overlays, raw modal priority, replacement, consumption, transforms and cleanup passed in both TUI modes");
