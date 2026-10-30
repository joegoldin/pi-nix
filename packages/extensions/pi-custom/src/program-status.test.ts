import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGoal } from "./tools/goal.ts";
import { registerBackgroundTasks } from "./tools/bg.ts";

function harness(goal?: object) {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const reports: { key: string; status: any }[] = [];
	const ctx = { hasUI: true, mode: "tui", cwd: "/tmp", isIdle: () => true, hasPendingMessages: () => false,
		ui: { setStatus() {}, notify() {}, setProgramStatus: (key: string, status: unknown) => reports.push({ key, status }) },
		sessionManager: { getSessionId: () => "test", getBranch: () => goal ? [{ type: "custom", customType: "goal-state", data: { goal } }] : [] },
	};
	const pi = { on: (name: string, handler: Function) => handlers.set(name, handler), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {} };
	return { pi, ctx, tools, reports, emit: (name: string, event = {}) => handlers.get(name)?.(event, ctx) };
}
for (const waitingFor of ["background", "external", "user"] as const) {
	test(`goal ${waitingFor} wait reports the right native activity without exposing the objective`, async () => {
		const h = harness({ id: "g", text: "PRIVATE_OBJECTIVE", status: "active", tokensUsed: 0, baselineTokens: 0, timeUsedSeconds: 0, waiting: { waitingFor, reason: "PRIVATE_REASON" } });
		registerGoal(h.pi as never, () => ({ goalTurnLimit: 0, goalNoProgressTurns: 0 }) as never);
		h.emit("session_start");
		expect(h.reports.at(-1)?.status.state).toBe(waitingFor === "user" ? "blocked" : "working");
		if (waitingFor === "user") expect(h.reports.at(-1)?.status.kind).toBe("question");
		expect(JSON.stringify(h.reports)).not.toContain("PRIVATE_");
		await h.emit("session_shutdown");
	});
}
test("background task lifecycle reports running and terminal results without commands or output", async () => {
	const h = harness();
	const cwd = mkdtempSync(join(tmpdir(), "pi-rex-bg-")); h.ctx.cwd = cwd;
	registerBackgroundTasks(h.pi as never);
	h.emit("session_start");
	let complete!: () => void;
	const done = new Promise<void>(resolve => { complete = resolve; });
	h.pi.sendMessage = () => complete();
	try {
		await h.tools.get("bg_run").execute("test", { name: "Build", command: "printf PRIVATE_OUTPUT", notifyOnCompletion: true, triggerOnCompletion: false }, undefined, undefined, h.ctx);
		expect(h.reports.some(row => row.status?.state === "working")).toBe(true);
		await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("background test timed out")), 3000))]);
		expect(h.reports.some(row => row.status?.state === "done")).toBe(true);
		expect(JSON.stringify(h.reports)).not.toContain("PRIVATE_OUTPUT");
	} finally { await h.emit("session_shutdown"); rmSync(cwd, { recursive: true, force: true }); }
});

test("todo progress counts live tasks, not groups or tombstones, and pending is not working", async () => {
	const { registerTodo } = await import("./tools/todo.ts");
	const h = harness();
	Object.assign(h.pi, { registerShortcut() {}, getActiveTools: () => ["todo"] });
	Object.assign(h.ctx.ui, { getToolsExpanded: () => false, setWidget() {} });
	registerTodo(h.pi as never);
	h.emit("session_start");
	const call = async (params: object) => { await h.tools.get("todo").execute("test", params); h.emit("tool_execution_end", { toolName: "todo" }); };
	await call({ action: "create", subject: "PRIVATE_GROUP", kind: "group" });
	await call({ action: "create", subject: "one", acceptanceCriteria: "First outcome verified", parentId: 1 });
	await call({ action: "create", subject: "two", acceptanceCriteria: "Second outcome verified", parentId: 1 });
	expect(h.reports.at(-1)?.status?.state).toBe("idle");
	await call({ action: "update", id: 2, status: "completed", evidence: "First outcome passed" });
	await call({ action: "update", id: 3, status: "in_progress" });
	expect(h.reports.at(-1)?.status).toMatchObject({ state: "working", progress: 50 });
	expect(JSON.stringify(h.reports)).not.toContain("PRIVATE_GROUP");
	await h.emit("session_shutdown");
});

test("subagent status uses bounded read-only snapshots, never prompt labels or foreign stale replies", async () => {
	const integration = await import("./program-status.ts") as any;
	const h = harness(); const listeners = new Map<string, Set<Function>>();
	const requests: any[] = [];
	const events = {
		on(name: string, fn: Function) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
		emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
	};
	Object.assign(h.pi, { events });
	events.on("subagents:rpc:v1:request", (request: unknown) => requests.push(request));
	integration.registerSubagentStatus?.(h.pi);
	h.emit("session_start"); await new Promise(resolve => setTimeout(resolve, 70));
	expect(requests).toHaveLength(1); expect(requests[0].method).toBe("status");
	const reply = (request: any, active: number, state: string) => events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: {
		fleet: { version: 1, totalActive: active }, asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, runs: [{ id: "run/1", kind: "workflow", label: "PRIVATE_TASK", state, children: [{ id: "child", kind: "step", label: "PRIVATE_PROMPT", state }] }] },
	} });
	reply(requests[0], 1, "running");
	expect(h.reports.at(-1)?.status.state).toBe("working");
	events.emit("subagent:jobs-changed", { version: 1 }); await new Promise(resolve => setTimeout(resolve, 70));
	reply(requests[1], 0, "failed"); expect(h.reports.some(row => row.status?.state === "error")).toBe(true);
	expect(JSON.stringify(h.reports)).not.toContain("PRIVATE_");
	events.emit("subagent:jobs-changed", {}); await new Promise(resolve => setTimeout(resolve, 70));
	h.emit("session_start"); const before = h.reports.length;
	reply(requests[2], 2, "running"); expect(h.reports.length).toBe(before);
	h.emit("session_shutdown");
});

for (const outcome of ["failed", "cancelled"] as const) {
	test(`background ${outcome} emits ${outcome === "failed" ? "error" : "idle"}, not success`, async () => {
		const h = harness(); const cwd = mkdtempSync(join(tmpdir(), "pi-rex-outcome-")); h.ctx.cwd = cwd;
		registerBackgroundTasks(h.pi as never); h.emit("session_start");
		let complete!: () => void; const done = new Promise<void>(resolve => { complete = resolve; }); h.pi.sendMessage = () => complete();
		try {
			const result = await h.tools.get("bg_run").execute("test", { name: "Check", command: outcome === "failed" ? "exit 7" : "sleep 10", triggerOnCompletion: false }, undefined, undefined, h.ctx);
			if (outcome === "cancelled") await h.tools.get("bg_kill").execute("kill", { taskId: result.details.task.id }, undefined, undefined, h.ctx);
			await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("task did not finish")), 3000))]);
			expect(h.reports.at(-1)?.status.state).toBe(outcome === "failed" ? "error" : "idle");
		} finally { await h.emit("session_shutdown"); rmSync(cwd, { recursive: true, force: true }); }
	});
}

test("a goal's user wait clears on real input and completion emits done", async () => {
	const h = harness({ id: "g", text: "PRIVATE_OBJECTIVE", status: "active", startedAt: Date.now(), updatedAt: Date.now(), iteration: 0, automaticModelTurns: 0, toolFreeRepeatCount: 0, tokensUsed: 0, baselineTokens: 0, timeUsedSeconds: 0, waiting: { waitingFor: "user", reason: "PRIVATE_REASON" } });
	registerGoal(h.pi as never, () => ({ goalTurnLimit: 0, goalNoProgressTurns: 0 }) as never);
	h.emit("session_start"); expect(h.reports.at(-1)?.status.state).toBe("blocked");
	h.emit("input", { text: "continue", source: "interactive" }); expect(h.reports.at(-1)?.status.state).toBe("working");
	const original = globalThis.setTimeout; let footerExpiry: (() => void) | undefined;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
		if (delay === 8000) footerExpiry = callback;
		return original(callback, delay);
	}) as typeof setTimeout);
	try {
		await h.tools.get("goal_complete").execute("finish", { goal_id: "g", summary: "Completed your task and verified the checks." }, undefined, undefined, h.ctx);
		expect(h.reports.at(-1)?.status.state).toBe("done");
		footerExpiry!(); expect(h.reports.at(-1)?.status.state).toBe("done");
		h.emit("input", { text: "next task", source: "interactive" }); expect(h.reports.at(-1)?.status).toBeUndefined();
	} finally { timer.mockRestore(); await h.emit("session_shutdown"); }
});

test("subagent workflows share one bounded record budget", async () => {
	const { EventEmitter } = await import("node:events"); const { registerSubagentStatus } = await import("./program-status.ts");
	const h = harness(); const bus = new EventEmitter(); let request: any;
	h.pi.events = { on(name: string, fn: (...args: any[]) => void) { bus.on(name, fn); return () => bus.off(name, fn); }, emit: bus.emit.bind(bus) } as any;
	bus.on("subagents:rpc:v1:request", value => { request = value; });
	registerSubagentStatus(h.pi as never); h.emit("session_start");
	try {
		await new Promise(resolve => setTimeout(resolve, 70));
		const runs = Array.from({ length: 128 }, (_, id) => ({ id: String(id), state: "running", children: [{ id: "one", state: "running" }, { id: "two", state: "running" }] }));
		bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { fleet: { version: 1, totalActive: 128 }, asyncSnapshot: { version: 1, kind: "pi-subagents.async-status-snapshot", runs } } });
		expect(h.reports.filter(row => row.key !== "subagents" && row.status?.state === "working").length).toBeLessThanOrEqual(128);
		expect(h.reports.at(-1)?.status.state).toBe("working");
	} finally { h.emit("session_shutdown"); }
});
