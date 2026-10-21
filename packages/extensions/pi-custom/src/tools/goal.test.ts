import { expect, spyOn, test } from "bun:test";
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

function waitingGoal(status = "active", resumeAt?: number) {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const notices: string[] = [];
	const initial = {
		id: "waiting-goal", text: "Verify the build", status, iteration: 2,
		startedAt: Date.now(), updatedAt: Date.now(), tokensUsed: 0, baselineTokens: 0,
		timeUsedSeconds: 12, automaticModelTurns: 3, toolFreeRepeatCount: 1,
		waiting: { reason: "Build A completion", ...(resumeAt === undefined ? {} : { resumeAt }) },
	};
	let saved: any = structuredClone(initial);
	const sent: string[] = [];
	const ctx = {
		isIdle: () => true, hasPendingMessages: () => false,
		ui: { setStatus() {}, notify: (text: string) => notices.push(text) },
		sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-state", data: { goal: initial } }] },
	};
	registerGoal({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), sendMessage() {},
		appendEntry: (_name: string, data: any) => { saved = structuredClone(data.goal); },
		sendUserMessage: (text: string) => sent.push(text),
	} as never, () => ({ goalTurnLimit: 100, goalNoProgressTurns: 10 }) as never);
	const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	emit("session_start");
	return { emit, ctx, sent, tools, commands, notices, saved: () => saved, wait: (reason = "Build B completion", waiting_for: string | undefined = "background") => tools.get("goal_wait").execute("call", { goal_id: initial.id, reason, waiting_for }, undefined, undefined, ctx) };
}

test("a background wake consumes the old wait so the new run can wait again", async () => {
	const h = waitingGoal();
	try {
		h.emit("before_agent_start", { type: "before_agent_start", messageType: "custom" });
		expect(h.saved().waiting).toBeUndefined();
		expect(h.saved().activeStartedAt).toBeNumber();
		expect(h.saved().automaticModelTurns).toBe(3);
		expect(h.saved().toolFreeRepeatCount).toBe(1);
		const result = await h.wait();
		expect(result.details.rejected).toBeUndefined();
		expect(result.terminate).toBe(true);
		expect(h.saved().waiting.reason).toBe("Build B completion");
		h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
		h.emit("agent_settled");
		expect(h.sent).toEqual([]);
	} finally { h.emit("session_shutdown"); }
});

test("a woken goal continues automatically if the new run does not wait again", () => {
	const h = waitingGoal();
	try {
		h.emit("before_agent_start", { type: "before_agent_start", messageType: "custom" });
		h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
		h.emit("agent_settled");
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toContain("waiting-goal");
	} finally { h.emit("session_shutdown"); }
});

test("merely settling a waiting goal does not wake it or allow duplicate waits", async () => {
	const h = waitingGoal();
	try {
		h.emit("agent_settled");
		expect(h.sent).toEqual([]);
		expect((await h.wait()).details.rejected).toBe("goal is already waiting");
	} finally { h.emit("session_shutdown"); }
});

test("background activity does not reactivate a paused goal", () => {
	const h = waitingGoal("paused");
	try {
		h.emit("before_agent_start", { type: "before_agent_start", messageType: "custom" });
		expect(h.saved().status).toBe("paused");
		expect(h.saved().waiting).toBeDefined();
		expect(h.sent).toEqual([]);
	} finally { h.emit("session_shutdown"); }
});

test("an extension-sourced user-message run also consumes the wait", () => {
	const h = waitingGoal();
	try {
		h.emit("input", { source: "extension", text: "The build finished" });
		expect(h.saved().waiting).toBeDefined();
		h.emit("before_agent_start", { messageType: "user", prompt: "The build finished" });
		expect(h.saved().waiting).toBeUndefined();
		expect(h.saved().automaticModelTurns).toBe(3);
	} finally { h.emit("session_shutdown"); }
});

test("external wake cancels the old safety deadline instead of leaving a second wake armed", () => {
	const clear = spyOn(globalThis, "clearTimeout");
	const h = waitingGoal("active", Date.now() + 60_000);
	try {
		h.emit("before_agent_start", { messageType: "custom" });
		expect(clear).toHaveBeenCalledTimes(1);
		expect(h.saved().waiting).toBeUndefined();
	} finally { h.emit("session_shutdown"); clear.mockRestore(); }
});

test("a queued wake between turns in the same run consumes the previous wait", async () => {
	const h = waitingGoal();
	try {
		h.emit("before_agent_start", { messageType: "custom" });
		expect((await h.wait("First job wake")).terminate).toBe(true);
		// The session may drain an already queued notification with agent.continue(),
		// which emits turn_start but not another before_agent_start.
		h.emit("turn_start", { turnIndex: 1 });
		expect(h.saved().waiting).toBeUndefined();
		expect(h.saved().automaticModelTurns).toBe(3);
		expect((await h.wait("Second job wake")).terminate).toBe(true);
	} finally { h.emit("session_shutdown"); }
});

test("wait recaps identify who must act, persist that distinction, and keep it in /goal status", async () => {
	for (const [kind, label, reason] of [
		["user", "Goal waiting for you", "Run the signing command from your clipboard, then paste the notarization result here."],
		["background", "Goal waiting for a background task", "The Mac build is running. I'll continue when it finishes."],
		["external", "Goal waiting for an external event", "The service is recovering. I'll check once at the scheduled time."],
	]) {
		const h = waitingGoal();
		try {
			h.emit("before_agent_start", { messageType: "custom" });
			const result = await h.wait(reason, kind);
			expect(result.content[0].text).toStartWith(label);
			expect(result.content[0].text).toContain(reason);
			expect(h.saved().waiting.waitingFor).toBe(kind);
			if (kind === "background") expect(result.content[0].text).toContain("No action needed from you");
			if (kind === "user") expect(result.content[0].text).not.toContain("No action needed from you");
			await h.commands.get("goal").handler("status", h.ctx);
			expect(h.notices.at(-1)).toContain(label);
			expect(h.notices.at(-1)).toContain(reason);
		} finally { h.emit("session_shutdown"); }
	}
});

test("new waits require an ownership category and user-facing tool field guidance", async () => {
	const h = waitingGoal();
	try {
		h.emit("before_agent_start", { messageType: "custom" });
		expect(h.tools.get("goal_wait").parameters.required).toContain("waiting_for");
		expect(h.tools.get("goal_wait").parameters.properties.waiting_for.anyOf.map((item: any) => item.const)).toEqual(["user", "background", "external"]);
		for (const [name, field] of [["goal_wait", "reason"], ["goal_blocked", "reason"], ["goal_complete", "summary"]]) {
			expect(h.tools.get(name).parameters.properties[field].description).toContain('"you"');
		}
	} finally { h.emit("session_shutdown"); }
});
