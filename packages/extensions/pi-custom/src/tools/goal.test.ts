import { expect, test } from "bun:test";
import { registerGoal } from "./goal.ts";
import { registerSteeringGuard, STEERING } from "../extras/steer.ts";

function harness() {
	const handlers = new Map<string, Function>();
	registerGoal({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerTool() {}, registerCommand() {}, appendEntry() {}, sendMessage() {},
	} as never, () => ({ goalTurnLimit: 0, goalNoProgressTurns: 0 }) as never);
	return handlers;
}

function interruptedGoal(queued: boolean, sendNow = false, stopReason = "aborted") {
	const handlers = new Map<string, Function[]>();
	let input: Function;
	let pending = queued;
	let idle = false;
	let editor = "draft";
	let saved: any;
	const sent: string[] = [];
	const pi = {
		on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool() {}, registerCommand() {}, sendMessage() {},
		appendEntry: (_type: string, data: unknown) => { saved = data; },
		sendUserMessage: (text: string) => sent.push(text),
	};
	registerSteeringGuard(pi as never);
	registerGoal(pi as never, () => ({ goalTurnLimit: 0, goalNoProgressTurns: 0 }) as never);
	const goal = { id: "g1", text: "Finish the work", status: "active", iteration: 0, tokensUsed: 0, baselineTokens: 0, timeUsedSeconds: 0 };
	const ctx = {
		hasUI: true, isIdle: () => idle, hasPendingMessages: () => pending,
		ui: {
			setStatus() {}, notify() {},
			onTerminalInput: (handler: Function) => { input = handler; return () => {}; },
			getEditorText: () => editor,
			setEditorText: (text: string) => { editor = text; },
		},
		sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-state", data: { goal } }] },
		abort: () => { if (pending) editor = `queued guidance\n\n${editor}`; pending = false; },
	};
	const emit = (name: string, event = {}) => { for (const handler of handlers.get(name) ?? []) handler(event, ctx); };
	emit("session_start");
	emit("before_agent_start", { prompt: "Work on the goal" });
	// Native queue controls set this marker before aborting without restoring the editor.
	if (sendNow) (globalThis as Record<symbol, unknown>)[STEERING] = true;
	else { input!("\x1b"); ctx.abort(); }
	emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
	const status = saved.goal.status;
	idle = true;
	emit("agent_settled");
	emit("session_shutdown");
	return { status, sent, editor };
}

test("Escape with queued guidance keeps the goal active while restoring the editor", () => {
	expect(interruptedGoal(true)).toEqual({ status: "active", sent: [], editor: "queued guidance\n\ndraft" });
});

test("native send-now marker keeps the goal active without restoring the draft", () => {
	expect(interruptedGoal(true, true)).toEqual({ status: "active", sent: [], editor: "draft" });
});

test("Escape without queued guidance still pauses the goal", () => {
	expect(interruptedGoal(false).status).toBe("paused");
});

test("interrupted tools also leave queued guidance in control of the next run", () => {
	expect(interruptedGoal(true, false, "toolUse")).toEqual({ status: "active", sent: [], editor: "queued guidance\n\ndraft" });
});

test("queued guidance does not hide a provider error", () => {
	expect(interruptedGoal(true, false, "error").status).toBe("blocked");
});

test("background completion can start a run with no prompt and no active goal", () => {
	const h = harness();
	expect(() => h.get("before_agent_start")!({ type: "before_agent_start" })).not.toThrow();
});

test("background completion still receives the active goal contract", () => {
	const h = harness();
	h.get("session_start")!({}, {
		ui: { setStatus() {} },
		sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-state", data: { goal: {
			id: "active-goal", text: "Verify the fix", status: "active", iteration: 0, tokensUsed: 0,
		} } }] },
	});
	const result = h.get("before_agent_start")!({ type: "before_agent_start" });
	expect(result.message.content).toContain("active-goal");
	expect(result.message.content).toContain("Verify the fix");
});
