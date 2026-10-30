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
const { KEYBINDINGS, KeybindingsManager } = await load("@earendil-works/pi-coding-agent/dist/core/keybindings.js");
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
  getAppKeyDisplay: (key) => ({ "app.message.dequeue": "Alt+Up", "app.message.sendNow": "Ctrl+Enter", "app.message.interruptAndSend": "Ctrl+Shift+Enter", "app.message.followUp": "Alt+Enter" })[key],
  session: { isCompacting: false },
};
proto.updatePendingMessagesDisplay.call(display);
const text = display.pendingMessagesContainer.render(120).map(stripTerminalSequences).join("\n");
assert(text.includes("Alt+Up to edit"));
assert(text.includes("Ctrl+Enter after current operation"));
assert(text.includes("Ctrl+Shift+Enter interrupt + send"));
assert(text.includes("/tmp/screenshot.png"));
display.session.queuedMessagesSendingCount = 1;
proto.updatePendingMessagesDisplay.call(display);
const armed = display.pendingMessagesContainer.render(160).map(stripTerminalSequences).join("\n");
assert(armed.includes("Sending next:"), "Ctrl-Enter must visibly arm queued messages");
assert(armed.includes("will send after current operation"));
assert(!armed.includes("Ctrl+Enter after current operation"), "an armed batch must not still ask to be sent");
display.session.queuedMessagesSendingCount = 0;
display.sendNowPending = true;
proto.updatePendingMessagesDisplay.call(display);
assert(display.pendingMessagesContainer.render(160).map(stripTerminalSequences).join("\n").includes("Scheduling queued messages"));
display.sendNowPending = false;
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
    abort: async () => { ctx.aborted++; },
    sendQueuedMessagesNow: async () => { ctx.sent++; },
  },
  sent: 0, aborted: 0, showError: (error) => { throw new Error(error); },
  updatePendingMessagesDisplay() {}, ui: { requestRender() {} },
};
await proto.handleSendQueuedNow.call(ctx);
assert.equal(ctx.aborted, 0, "Ctrl-Enter must not cancel the current operation");
assert.equal(ctx.sent, 1);
assert.equal(ctx.editor.getText(), "UNSUBMITTED DRAFT");
assert.notEqual(globalThis[Symbol.for("pi-custom.steering")], true);
assert.equal(KEYBINDINGS["app.message.interruptAndSend"].defaultKeys, "ctrl+shift+enter");
const keys = new KeybindingsManager();
assert(keys.matches("\x1b[13;5u", "app.message.sendNow"));
assert(keys.matches("\x1b[13;6u", "app.message.interruptAndSend"));
assert(!keys.matches("\x1b[13;6u", "app.message.sendNow"));
const { CustomEditor } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js");
const routed = [];
const routingEditor = { actionHandlers: new Map(), keybindings: keys, onAction: CustomEditor.prototype.onAction };
proto.setupKeyHandlers.call({
  editor: routingEditor, defaultEditor: routingEditor, ui: {}, wrapEditorInput() {},
  handleSendQueuedNow: (interrupt = false) => routed.push(interrupt),
});
CustomEditor.prototype.handleInput.call(routingEditor, "\x1b[13;5u");
CustomEditor.prototype.handleInput.call(routingEditor, "\x1b[13;6u");
assert.deepEqual(routed, [false, true], "real editor key routing keeps safe and interrupting send distinct");
ctx.session.abort = () => { ctx.aborted++; return new Promise(resolve => { release = resolve; }); };
const sending = proto.handleSendQueuedNow.call(ctx, true);
assert.equal(globalThis[Symbol.for("pi-custom.steering")], true);
await proto.handleSendQueuedNow.call(ctx, true);
assert.equal(ctx.sent, 1);
release();
await sending;
assert.equal(ctx.sent, 2, "Ctrl-Shift-Enter must actually start the queued input after abort");
assert.equal(ctx.aborted, 1);
assert.equal(ctx.editor.getText(), "UNSUBMITTED DRAFT");
assert.equal(globalThis[Symbol.for("pi-custom.steering")], false);
const cancelled = proto.handleSendQueuedNow.call(ctx, true);
ctx.sendNowPending = false; // Native Escape cancels before restoring the queue.
ctx.sendNowGeneration++;
release();
await cancelled;
assert.equal(ctx.sent, 2);
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

// Exercise the real session and agent loop with a held tool, not a mocked abort.
// Only provider preparation/streaming are replaced: these tests never use inference.
const { createAssistantMessageEventStream, getModel } = await load("@earendil-works/pi-ai/dist/compat.js");
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("queue lifecycle did not complete")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
for (const { interrupt, followUp, atBoundary, cancel } of [
  { interrupt: false, followUp: true },
  { interrupt: true, followUp: false },
  { interrupt: true, followUp: true },
  { interrupt: true, followUp: false, atBoundary: true },
  { interrupt: true, followUp: false, atBoundary: true, cancel: true },
]) {
  const started = deferred();
  const finish = deferred();
  const boundary = deferred();
  let operationSignal;
  let operationFinished = false;
  const requests = [];
  const events = [];
  const model = getModel("openai", "gpt-4o");
  const { session: live } = await api.createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, model,
    sessionManager: api.SessionManager.inMemory(dir),
    settingsManager: api.SettingsManager.inMemory({ compaction: { enabled: false } }),
    tools: ["held_operation"],
    customTools: [{
      name: "held_operation", label: "Held operation", description: "Wait for the test",
      parameters: { type: "object", properties: {} },
      execute: async (_id, _args, signal) => {
        operationSignal = signal;
        started.resolve();
        await new Promise((resolve, reject) => {
          const abort = () => reject(new Error("The operation was aborted"));
          signal.addEventListener("abort", abort, { once: true });
          finish.promise.then(() => { signal.removeEventListener("abort", abort); resolve(); });
        });
        operationFinished = true;
        return { content: [{ type: "text", text: "operation finished" }], details: {} };
      },
    }],
  });
  live._prepareRun = async trigger => [{
    role: "user", content: [{ type: "text", text: trigger.prompt }, ...(trigger.images ?? [])], timestamp: Date.now(),
  }];
  if (atBoundary) live.agent.prepareNextTurnWithContext = async (_context, signal) => {
    boundary.resolve();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("boundary aborted")), { once: true }));
  };
  live.agent.streamFunction = (_model, context, options) => {
    const aborted = options?.signal?.aborted;
    if (!aborted) requests.push(structuredClone(context.messages));
    const first = requests.length === 1;
    const message = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: first ? [{ type: "toolCall", id: "held", name: "held_operation", arguments: {} }] : [{ type: "text", text: "handled queued input" }],
      stopReason: aborted ? "aborted" : first ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push(aborted ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: message.stopReason, message }));
    return stream;
  };
  live.subscribe(event => events.push(event));
  const ui = { ...ctx, session: live, sendNowPending: false, sendNowGeneration: 0 };
  let running;
  try {
    running = live._startRun({ messageType: "user", prompt: "original work" });
    await within(Promise.race([started.promise, running.then(() => { throw new Error("run ended before the held operation"); })]));
    await live._queueSteer("same text", [image]);
    if (followUp) await live._queueFollowUp("follow-up", [image]);
    if (atBoundary) {
      finish.resolve();
      await within(boundary.promise);
      assert.equal(live.pendingMessageCount, 1);
      assert.equal(live.agent.getQueuedMessages().length, 0, "input has been selected but not yet delivered");
    }
    const sending = proto.handleSendQueuedNow.call(ui, interrupt);
    if (cancel) {
      ui.sendNowPending = false;
      ui.sendNowGeneration++;
      assert.deepEqual(live.clearQueue(), { steering: ["same text"], followUp: [] });
    }
    if (!interrupt) {
      await within(sending);
      assert.equal(operationSignal.aborted, false);
      assert.equal(operationFinished, false);
      assert.equal(requests.length, 1, "wait for the running operation, not just its start");
      assert.deepEqual(live.getFollowUpMessages(), [], "follow-ups become next-boundary input");
      assert.deepEqual(live.getSteeringMessages(), ["same text", "follow-up"]);
      assert.equal(live.queuedMessagesSendingCount, 2, "only the captured batch is armed");
      await live._queueSteer("same text", [image]);
      assert.equal(live.queuedMessagesSendingCount, 2, "a later duplicate is not armed");
      finish.resolve();
    }
    await within(Promise.all([running, sending]));
    assert.equal(operationSignal.aborted, interrupt);
    assert.equal(operationFinished, !interrupt || !!atBoundary);
    assert.equal(requests.length, cancel ? 1 : interrupt ? 2 : 3, `queued input is actually processed (${atBoundary ? "between turns" : interrupt ? "interrupt" : "safe"})`);
    if (!cancel) {
      const expected = followUp ? ["same text", "follow-up"] : ["same text"];
      const submitted = requests[1].filter(m => m.role === "user").slice(-expected.length);
      assert.deepEqual(submitted.map(m => m.content.find(c => c.type === "text")?.text), expected);
      assert.deepEqual(submitted.map(m => m.content.find(c => c.type === "image")), expected.map(() => image));
    }
    assert.equal(events.filter(e => e.type === "agent_start").length, interrupt && !cancel ? 2 : 1);
    assert.deepEqual(events.filter(e => e.type === "agent_settled").map(e => e.aborted), cancel ? [true] : interrupt ? [true, false] : [false]);
    assert.equal(live.agent.getQueuedMessages().length, 0, "cancelled input must not reappear after settlement");
    assert.equal(live.pendingMessageCount, 0);
    assert.equal(live.queuedMessagesSendingCount, 0, "delivery or cancellation clears feedback");
    assert.equal(ui.editor.getText(), "UNSUBMITTED DRAFT");
    assert.equal(live.isIdle, true);
  } finally {
    finish.resolve();
    await live.abort();
    await running;
    live.dispose();
  }
}
console.log("Real operation: Ctrl-Enter finishes without cancellation; Ctrl-Shift-Enter aborts and runs queued input; batches, images and later arrivals pass.");

// Cancelling before the first request must not erase the run's original prompt.
// Only messages selected out of a queue need to be returned for later delivery.
const earlyAbort = new Agent({
  initialState: { model: getModel("openai", "gpt-4o") },
  streamFn: () => { throw new Error("request cancelled"); },
});
earlyAbort.subscribe(event => { if (event.type === "agent_start") earlyAbort.abort(); });
await earlyAbort.prompt("Keep the original task in context");
assert(earlyAbort.state.messages.some(message => message.role === "user" && (typeof message.content === "string" ? message.content === "Keep the original task in context" : message.content.some(part => part.type === "text" && part.text === "Keep the original task in context"))), "abort must not erase the original prompt while protecting queued input");
