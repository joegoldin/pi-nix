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
	const records = new Map<string, any>();
	const ctx = { hasUI: true, mode: "tui", cwd: "/tmp", isIdle: () => true, hasPendingMessages: () => false,
		ui: { setStatus() {}, notify() {}, setProgramStatus: (key: string, status: unknown) => {
			reports.push({ key, status });
			if (status) records.set(key, status);
			else for (const owned of records.keys()) if (owned === key || owned.startsWith(`${key}/`)) records.delete(owned);
		} },
		sessionManager: { getSessionId: () => "test", getBranch: () => goal ? [{ type: "custom", customType: "goal-state", data: { goal } }] : [] },
	};
	const pi = { on: (name: string, handler: Function) => handlers.set(name, handler), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {} };
	return { pi, ctx, tools, reports, records, emit: (name: string, event = {}) => handlers.get(name)?.(event, ctx) };
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

for (const outcome of ["failed", "cancelled"] as const) {
	test(`background ${outcome} emits ${outcome === "failed" ? "error" : "idle"}, not success`, async () => {
		const h = harness(); const cwd = mkdtempSync(join(tmpdir(), "pi-rex-outcome-")); h.ctx.cwd = cwd;
		registerBackgroundTasks(h.pi as never); h.emit("session_start");
		let complete!: () => void; const done = new Promise<void>(resolve => { complete = resolve; }); h.pi.sendMessage = () => complete();
		try {
			const result = await h.tools.get("bg_run").execute("test", { name: "Check", command: outcome === "failed" ? "exit 7" : "sleep 10", triggerOnCompletion: false }, undefined, undefined, h.ctx);
			if (outcome === "cancelled") await h.tools.get("bg_kill").execute("kill", { taskId: result.details.task.id }, undefined, undefined, h.ctx);
			await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("task did not finish")), 3000))]);
			expect(h.reports.some(row => row.status?.state === (outcome === "failed" ? "error" : "idle"))).toBe(true);
		} finally { await h.emit("session_shutdown"); rmSync(cwd, { recursive: true, force: true }); }
	});
}

test("a goal's user wait clears on real input and completion emits done", async () => {
	const h = harness({ id: "g", text: "PRIVATE_OBJECTIVE", status: "active", startedAt: Date.now(), updatedAt: Date.now(), iteration: 0, automaticModelTurns: 0, toolFreeRepeatCount: 0, tokensUsed: 0, baselineTokens: 0, timeUsedSeconds: 0, waiting: { waitingFor: "user", reason: "PRIVATE_REASON" } });
	const activity = registerGoal(h.pi as never, () => ({ goalTurnLimit: 0, goalNoProgressTurns: 0 }) as never);
	h.emit("session_start"); expect(h.reports.at(-1)?.status.state).toBe("blocked");
	expect(activity.active()).toBe(true);
	h.emit("input", { text: "continue", source: "interactive" }); expect(h.reports.at(-1)?.status.state).toBe("working");
	const original = globalThis.setTimeout; let footerExpiry: (() => void) | undefined;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
		if (delay === 8000) footerExpiry = callback;
		return original(callback, delay);
	}) as typeof setTimeout);
	try {
		await h.tools.get("goal_complete").execute("finish", { goal_id: "g", summary: "Completed your task and verified the checks." }, undefined, undefined, h.ctx);
		expect(activity.active()).toBe(false);
		expect(h.reports.at(-1)?.status.state).toBe("done");
		footerExpiry!(); expect(h.reports.at(-1)?.status.state).toBe("done");
		h.emit("input", { text: "next task", source: "interactive" }); expect(h.reports.at(-1)?.status).toBeUndefined();
	} finally { timer.mockRestore(); await h.emit("session_shutdown"); }
});
test("automatic background completion stays working until its follow-up consumes it, then clears", async () => {
 const h = harness(); const cwd = mkdtempSync(join(tmpdir(), "pi-bg-followup-")); h.ctx.cwd = cwd;
 registerBackgroundTasks(h.pi as never); h.emit("session_start");
 let complete!: () => void; const done = new Promise<void>(resolve => { complete = resolve; }); h.pi.sendMessage = () => complete();
 try {
  await h.tools.get("bg_run").execute("run", { name: "Check", command: "exit 7" }, undefined, undefined, h.ctx);
  await done;
  expect([...h.records.values()].filter(Boolean).every(status => status.state === "working")).toBe(true);
  h.emit("agent_start");
  expect([...h.records.values()].filter(Boolean)).toHaveLength(0);
  const result = await h.tools.get("bg_status").execute("status", {});
  expect(result.details.tasks[0]).toMatchObject({ status: "failed", exitCode: 7 });
 } finally { await h.emit("session_shutdown"); rmSync(cwd, { recursive: true, force: true }); }
});


test("manual background results clear on inspection or real input, without losing history", async () => {
 const h = harness(); const cwd = mkdtempSync(join(tmpdir(), "pi-bg-seen-")); h.ctx.cwd = cwd;
 registerBackgroundTasks(h.pi as never); h.emit("session_start");
 let complete!: () => void; let done = new Promise<void>(resolve => { complete = resolve; }); h.pi.sendMessage = () => complete();
 try {
  const launch = () => h.tools.get("bg_run").execute("run", { name: "Check", command: "exit 7", triggerOnCompletion: false }, undefined, undefined, h.ctx);
  const first = await launch(); await done;
  expect([...h.records.values()].some(status => status.state === "error")).toBe(true);
  await h.tools.get("bg_status").execute("status", { taskId: first.details.task.id });
  expect([...h.records.values()].filter(Boolean)).toHaveLength(0);
  done = new Promise<void>(resolve => { complete = resolve; }); await launch(); await done;
  h.emit("input", { source: "interactive", text: "continue" });
  expect([...h.records.values()].filter(Boolean)).toHaveLength(0);
  expect((await h.tools.get("bg_status").execute("status", {})).details.tasks).toHaveLength(2);
 } finally { await h.emit("session_shutdown"); rmSync(cwd, { recursive: true, force: true }); }
});
