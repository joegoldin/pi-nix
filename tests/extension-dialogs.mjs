import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const modules = process.argv[2];
const load = (path) => import(pathToFileURL(`${modules}/${path}`));
const { InteractiveMode } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js");
const { initTheme } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const editor = { text: "draft", getText() { return this.text; }, setText(text) { this.text = text; } };
const container = { children: [editor], clear() { this.children = []; }, addChild(c) { this.children.push(c); } };
const mode = Object.assign(Object.create(InteractiveMode.prototype), {
  editor, editorContainer: container, extensionDialogs: [],
  ui: { setFocus() {}, requestRender() {} }, keybindings: {}, disposeActiveSelector() {},
  programStatus: { setBlocked() {} },
});
const api = mode.createExtensionUIContext();
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let finishQuestion;
const question = { render: () => ["QUESTION"], invalidate() {}, dispose() {} };
const pendingQuestion = api.custom((_tui, _theme, _kb, done) => { finishQuestion = done; return question; });
await flush();
assert.equal(container.children[0], question);
const permission = api.confirm("Concurrent child permission", "Allow the operation?");
await flush();
assert.notEqual(container.children[0], question, "Nested permission must be answerable while its parent waits");
assert.equal(mode.extensionDialogs.length, 2);
container.children[0].handleInput("\x1b");
assert.equal(await permission, false, "Cancelling permission must not grant authority");
assert.equal(container.children[0], question, "The unanswered question must return intact");
finishQuestion("answer");
assert.equal(await pendingQuestion, "answer");
assert.equal(container.children[0], editor);
assert.equal(editor.text, "draft");

// A failed custom factory must leave subsequent dialogs usable.
await assert.rejects(api.custom(() => { throw new Error("factory failed"); }), /factory failed/);
const final = api.custom((_tui, _theme, _kb, done) => { done("next"); return question; });
assert.equal(await final, "next");
console.log("Native dialog stacking, nested permission cancellation, rejection recovery and draft preservation passed");

if (process.argv[3]) {
  const { registerAsk } = await import(pathToFileURL(process.argv[3]));
  let tool; const decisions = [];
  registerAsk({ on() {}, registerTool(value) { tool = value; }, appendEntry(...args) { decisions.push(args); }, events: { emit() {} } });
  const controller = new AbortController();
  const asking = tool.execute("question", { questions: [{ header: "Scratch", question: "Allow scratch writes?", options: [{ label: "Yes", description: "Allow only scratch writes." }, { label: "No", description: "Do not allow writes." }] }] }, controller.signal, undefined, { mode: "tui", hasUI: true, ui: api });
  await flush();
  const actions = [];
  Object.defineProperty(mode, "session", { value: {
    pendingMessageCount: 1, isCompacting: false,
    async abort() { controller.abort(); await asking; actions.push("aborted"); },
    async sendQueuedMessagesNow() { actions.push("sent"); },
  } });
  mode.sendNowGeneration = 0;
  mode.updatePendingMessagesDisplay = () => {};
  mode.showError = (message) => { throw new Error(message); };
  const sending = mode.handleSendQueuedNow();
  const completed = await Promise.race([sending.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1000))]);
  assert(completed, "Ctrl+Enter remained blocked waiting for an abandoned questionnaire");
  assert.deepEqual(actions, ["aborted", "sent"]);
  assert.equal((await asking).details.cancelled, true);
  assert.deepEqual(decisions, [], "Interrupted questions must not become approval records");
  assert.equal(container.children[0], editor);
  console.log("Native send-now cancels the real questionnaire before sending queued input, without granting approval");
}

// A background editor-slot dialog must not steal input from a visible inspector.
const { TuiMainScreen, TuiAltScreen, Container } = await load("@earendil-works/pi-tui/dist/index.js");
for (const Host of [TuiMainScreen, TuiAltScreen]) {
  const terminal = { columns: 100, rows: 30, start() {}, stop() {}, write() {}, hideCursor() {}, showCursor() {} };
  const ui = new Host(terminal);
  ui.requestRender = () => {};
  const editor = { text: "draft", render: () => ["EDITOR"], invalidate() {}, getText() { return this.text; }, setText(text) { this.text = text; } };
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  ui.addChild(editorContainer);
  ui.setFocus(editor);
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    editor, editorContainer, extensionDialogs: [], ui, keybindings: {}, disposeActiveSelector() {},
    programStatus: { setBlocked() {} },
  });
  const api = host.createExtensionUIContext();
  let inspector;
  const inspection = api.custom((_ui, _theme, _keys, done) => {
    inspector = { render: () => ["INSPECTOR"], invalidate() {}, handleInput(key) { if (key === "\x1b") done("closed"); } };
    return inspector;
  }, { overlay: true });
  await flush();
  let answered = false;
  const permission = api.confirm("Background permission", "Allow?").then(value => { answered = true; return value; });
  await flush();
  assert.equal(ui.getFocusedComponent(), inspector, `${Host.name}: hidden prompt stole focus`);
  ui.handleTerminalInput("\r");
  await flush();
  assert.equal(answered, false, "Enter must not approve a hidden permission");
  const abort = new AbortController();
  const cancelled = api.confirm("Cancelled background prompt", "Allow?", { signal: abort.signal });
  await flush();
  abort.abort();
  assert.equal(await cancelled, false);
  assert.equal(ui.getFocusedComponent(), inspector, "Aborting a hidden prompt must leave inspector focused");
  let nestedHandle;
  nestedHandle = ui.showOverlay({ render: () => ["NESTED"], invalidate() {}, handleInput(key) { if (key === "\x1b") nestedHandle.hide(); } });
  ui.handleTerminalInput("\x1b");
  assert.equal(ui.getFocusedComponent(), inspector, "Nested overlay closes before inspector");
  ui.handleTerminalInput("\x1b");
  await flush();
  assert.equal(await inspection, "closed");
  assert.equal(answered, false, "Inspector Escape must not answer the hidden permission");
  assert.equal(ui.getFocusedComponent(), editorContainer.children[0], "Pending permission must receive focus after inspector closes");
  ui.handleTerminalInput("\x1b");
  assert.equal(await permission, false);
  assert.equal(ui.getFocusedComponent(), editor);
  assert.equal(editor.text, "draft");
  ui.stop();
}
console.log("Both TUI modes defer hidden permission input until the inspector closes");
