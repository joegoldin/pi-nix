import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const modules = process.argv[2];
const load = (p) => import(pathToFileURL(`${modules}/${p}`).href);
const { Agent } = await load("@earendil-works/pi-agent-core/dist/index.js");
const { AgentSession } = await load("@earendil-works/pi-coding-agent/dist/core/agent-session.js");
const { InteractiveMode } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js");
const { Container, stripTerminalSequences } = await load("@earendil-works/pi-tui/dist/index.js");
const { initTheme } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const { KEYBINDINGS } = await load("@earendil-works/pi-coding-agent/dist/core/keybindings.js");
assert.equal(KEYBINDINGS["app.message.sendNow"].defaultKeys, "ctrl+enter");
assert.equal(KEYBINDINGS["app.message.followUp"].defaultKeys, "alt+enter");
const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
const message = { role: "user", content: [{ type: "text", text: "inspect this" }, image], timestamp: 1 };
const agent = new Agent();
agent.steer(message);
agent.followUp({ role: "user", content: [{ type: "text", text: "then test" }], timestamp: 2 });
const custom = { role: "custom", customType: "aside", content: "extension context", display: false, timestamp: 2 };
agent.steer(custom);
assert.equal(typeof AgentSession.prototype.sendQueuedMessagesNow, "function", "native send-now must use queued content, not editor text");
let trigger;
let additional;
const session = {
  agent, isIdle: true, _steeringMessages: ["inspect this"], _followUpMessages: ["then test"],
  _submittedQueueMessages: new WeakSet(), _emitQueueUpdate() {},
  _startRun: async (value, started, queued) => { trigger = value; additional = queued; started([message, ...queued]); },
};
await AgentSession.prototype.sendQueuedMessagesNow.call(session);
assert.equal(trigger.prompt, "inspect this");
assert.deepEqual(trigger.images, [image]);
assert.deepEqual(agent.getQueuedMessages(), [custom], "all queued user input is submitted together without dropping extension messages");
assert.equal(additional[0].content[0].text, "then test");
assert.deepEqual(session._steeringMessages, []);
assert.deepEqual(session._followUpMessages, []);
assert(session._submittedQueueMessages.has(message), "already-submitted input must not clear newer identical queue entries");
agent.clearAllQueues();
agent.steer(message);
session._startRun = async () => { throw new Error("preparation failed"); };
await assert.rejects(() => AgentSession.prototype.sendQueuedMessagesNow.call(session), /preparation failed/);
assert.equal(agent.getQueuedMessages()[0], message, "failed preparation does not lose the message or its image");

const proto = InteractiveMode.prototype;
const display = {
  pendingMessagesContainer: new Container(),
  getAllQueuedMessages: () => ({ steering: ["/tmp/screenshot.png inspect this"], followUp: [] }),
  getAppKeyDisplay: (key) => ({ "app.message.dequeue": "Alt+Up", "app.message.sendNow": "Ctrl+Enter", "app.message.followUp": "Alt+Enter" })[key],
  session: { isCompacting: false },
};
proto.updatePendingMessagesDisplay.call(display);
const text = display.pendingMessagesContainer.render(120).map(stripTerminalSequences).join("\n");
assert(text.includes("Alt+Up to edit"));
assert(text.includes("Ctrl+Enter to send now"));
assert(text.includes("/tmp/screenshot.png"));
assert(!text.includes("Queued messages:"), "there is only the native queue hint");
display.getAllQueuedMessages = () => ({ steering: [""], followUp: [] });
proto.updatePendingMessagesDisplay.call(display);
assert(display.pendingMessagesContainer.render(120).map(stripTerminalSequences).join("\n").includes("[image attachment]"));
display.getAllQueuedMessages = () => ({ steering: [], followUp: [] });
proto.updatePendingMessagesDisplay.call(display);
assert.equal(display.pendingMessagesContainer.children.length, 0);

let release;
const ctx = {
  sendNowPending: false, sendNowGeneration: 0,
  editor: { getText: () => "UNSUBMITTED DRAFT" },
  session: {
    isStreaming: true, isCompacting: false, pendingMessageCount: 1,
    abort: () => new Promise(resolve => { release = resolve; }),
    sendQueuedMessagesNow: async () => { ctx.sent++; },
  },
  sent: 0, showError: (error) => { throw new Error(error); },
  updatePendingMessagesDisplay() {}, ui: { requestRender() {} },
};
const sending = proto.handleSendQueuedNow.call(ctx);
assert.equal(globalThis[Symbol.for("pi-custom.steering")], true);
await proto.handleSendQueuedNow.call(ctx);
assert.equal(ctx.sent, 0);
release();
await sending;
assert.equal(ctx.sent, 1);
assert.equal(ctx.editor.getText(), "UNSUBMITTED DRAFT");
assert.equal(globalThis[Symbol.for("pi-custom.steering")], false);
const cancelled = proto.handleSendQueuedNow.call(ctx);
ctx.sendNowPending = false; // Native Escape cancels before restoring the queue.
release();
await cancelled;
assert.equal(ctx.sent, 1);
let followUp;
await proto.handleFollowUp.call({
  session: { isStreaming: true, pendingMessageCount: 1, isCompacting: false,
    prompt: async (text, options) => { followUp = { text, options }; } },
  editor: { getText: () => "a follow-up draft", setText() {} },
  updatePendingMessagesDisplay() {}, ui: { requestRender() {} },
});
assert.equal(followUp.text, "a follow-up draft");
assert.equal(followUp.options.streamingBehavior, "followUp", "Alt+Enter keeps its native behavior");
console.log("Native queue: one hint, image-preserving send, preparation failure, draft preservation, repeat/cancel, native Alt+Enter pass.");

// Real session bookkeeping: empty-text images must drain, and sending an old
// queue must not consume a newer message with the same text from its display.
const api = await load("@earendil-works/pi-coding-agent/dist/index.js");
const dir = await mkdtemp(`${tmpdir()}/pi-native-queue-`);
const loader = new api.DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
await loader.reload();
const { session: real } = await api.createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: api.SessionManager.inMemory(dir), settingsManager: api.SettingsManager.inMemory({}) });
try {
  await real._queueSteer("", [image]);
  const imageOnly = real.agent.getQueuedMessages()[0];
  await real._handleAgentEvent({ type: "message_start", message: imageOnly });
  assert.equal(real.pendingMessageCount, 0);
  real.agent.clearAllQueues();
  await real._queueSteer("same text", [image]);
  await real._queueFollowUp("follow-up", [image]);
  let submitted;
  real._startRun = async (trigger, started, queued) => {
    submitted = [{ role: "user", content: [{ type: "text", text: trigger.prompt }, ...trigger.images], timestamp: 3 }, ...queued];
    started(submitted);
  };
  await real.sendQueuedMessagesNow();
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted.map(m => m.content.find(c => c.type === "image")), [image, image]);
  assert.equal(real.pendingMessageCount, 0);
  await real._queueSteer("same text", [image]);
  for (const message of submitted) await real._handleAgentEvent({ type: "message_start", message });
  assert.equal(real.pendingMessageCount, 1, "newer identical text remains visibly queued");
} finally { real.dispose(); }
console.log("Real session: image-only drainage, batch images, and newer duplicate text pass.");
