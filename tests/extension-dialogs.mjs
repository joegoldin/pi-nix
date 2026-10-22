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
  editor, editorContainer: container, extensionDialogTail: Promise.resolve(),
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
assert.equal(container.children[0], question, "Permission prompt displaced an unanswered questionnaire");
finishQuestion("answer");
assert.equal(await pendingQuestion, "answer");
await flush();
assert(mode.extensionSelector, "Queued permission prompt never opened");
mode.extensionSelector.handleInput("\x1b");
assert.equal(await permission, false, "Cancelling permission must not grant authority");
assert.equal(container.children[0], editor);
assert.equal(editor.text, "draft");

// A failed custom factory must release the queue for later dialogs.
await assert.rejects(api.custom(() => { throw new Error("factory failed"); }), /factory failed/);
const final = api.custom((_tui, _theme, _kb, done) => { done("next"); return question; });
assert.equal(await final, "next");
console.log("Question/permission serialization, rejection recovery, draft preservation and no implicit approval passed");

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
