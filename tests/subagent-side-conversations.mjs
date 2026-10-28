import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
const { collectFleetSnapshot, SubagentFleetComponent, openSubagentFleet } = await import(pathToFileURL(join(root, "src/tui/fleet.js")));
const key = Symbol.for("pi-custom.side-conversations.v1");
const previous = globalThis[key];
const state = { currentSessionId: "main-session-file", asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map() };
const theme = { fg: (_slot, text) => text, bold: text => text };
const tui = { requestRender() {}, terminal: { rows: 40 } };
let opened = [], closed = false;
try {
  globalThis[key] = { version: 1, owners: new Map([[state.currentSessionId, {
    snapshot: () => [
      { id: "side-a", label: "First discussion", state: "running", startedAt: 1, updatedAt: 2, preview: "PRIVATE_TRANSCRIPT" },
      { id: "side-b", label: "Forked discussion", state: "idle", startedAt: 2, updatedAt: 3, parentId: "side-a" },
    ],
    open: async id => { assert(closed, "Fleet must release focus before opening a conversation"); assert.equal(state.fleetInspectorOpen, false); opened.push(id); },
  }]]) };
  const snapshot = collectFleetSnapshot(state);
  assert.equal(snapshot.items.length, 2, "Side conversations must appear in the existing fleet");
  assert(!JSON.stringify(snapshot).includes("PRIVATE_TRANSCRIPT"), "Do not copy transcripts into fleet metadata");
  assert.equal(snapshot.items[1].run.currentAction, "Fork of side-a");
  assert.equal(collectFleetSnapshot({ ...state, currentSessionId: "other-session" }).items.length, 0);
  const ctx = { ui: { setWidget() {}, custom: async factory => {
    let result;
    const component = factory(tui, theme, {}, value => { result = value; });
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    component.dispose();
    closed = true;
    return result;
  } } };
  await openSubagentFleet(ctx, state, { markdownTheme: {}, actions: {} });
  assert.deepEqual(opened, ["side-b"]);
  let returns = 0;
  const component = new SubagentFleetComponent(tui, theme, state, () => returns++, { markdownTheme: {}, actions: { stop: () => { throw new Error("Ctrl+C must not stop a child"); } } });
  component.steerDraft = "unsent steering";
  component.handleInput("\x03");
  assert.equal(returns, 1, "Ctrl+C from a nested child form returns to main");
  component.dispose();
  console.log("Existing fleet opens owned side conversations after focus release; Ctrl+C preserves child work");
} finally {
  if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
}

// Exercise the shipped producer and consumer together, not just a mock registry.
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { registerBtw } = await import(pathToFileURL(join(process.argv[3], "src/tools/btw.ts")));
const directory = mkdtempSync(join(tmpdir(), "btw-fleet-"));
try {
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage({ role: "user", content: "Main conversation", timestamp: 1 });
  const nativeState = { ...state, currentSessionId: manager.getSessionFile(), fleetInspectorOpen: false };
  let command, shutdown, childViews = 0;
  const ctx = { mode: "tui", cwd: directory, sessionManager: manager, ui: {
    notify(message, level) { if (level === "error") throw new Error(message); },
    setWidget() {}, getEditorText: () => "MAIN_DRAFT", setEditorText() { throw new Error("Closing a child must preserve the main draft"); },
    custom: factory => new Promise(resolve => {
      const component = factory(tui, theme, {}, resolve);
      if (component instanceof SubagentFleetComponent) component.handleInput("\r");
      else {
        assert.equal(nativeState.fleetInspectorOpen, false, "The fleet must close before the side editor opens");
        childViews++;
        assert(component.render(100).join("\n").includes("read-only"));
        component.handleInput("\x03");
      }
      component.dispose?.();
    }),
  } };
  registerBtw({
    registerCommand(_name, value) { command = value; },
    appendEntry(type, data) { manager.appendCustomEntry(type, data); },
    on(name, handler) { if (name === "session_shutdown") shutdown = handler; },
  });
  await command.handler("new", ctx);
  assert.equal(collectFleetSnapshot(nativeState).items.length, 1);
  await openSubagentFleet(ctx, nativeState, { markdownTheme: {}, actions: {} });
  assert.equal(childViews, 2, "Selecting the real /btw entry must reopen its conversation");
  await shutdown();
  assert.equal(collectFleetSnapshot(nativeState).items.length, 0, "Shutdown must unregister the owner");
  console.log("Packaged /btw provider and fleet consumer reopen the same conversation without changing the main draft");
} finally { rmSync(directory, { recursive: true, force: true }); }
