import { expect, test } from "bun:test";
import { registerTodo, type TodoClock } from "./todo.ts";

// Exercise Pi's prompt builder, not a copy of its custom-prompt behavior.
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

function harness(active = true, clock?: TodoClock) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const messages: { message: any; options: any }[] = [];
	const userMessages: {message: string; options: any}[] = [];
	let tool: any;
	registerTodo({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerTool: (definition: unknown) => { tool = definition; },
		registerCommand: (name: string, command: unknown) => commands.set(name, command), registerShortcut() {},
		sendUserMessage: (message: string, options: any) => userMessages.push({ message, options }),
		sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getActiveTools: () => active ? ["todo"] : [],
	} as never, clock);
	const base = (customPrompt?: string) => buildSystemPrompt({
		cwd: "/tmp", selectedTools: active ? ["todo"] : [], customPrompt,
		toolSnippets: { todo: tool.promptSnippet }, toolGuidelines: { todo: tool.promptGuidelines },
	});
	const apply = (systemPrompt: string) => handlers.get("before_agent_start")?.({ systemPrompt })?.systemPrompt ?? systemPrompt;
	return { tool, base, apply, handlers, commands, entries, messages, userMessages };
}

test("custom system prompts retain proactive milestone-level task guidance", () => {
	const h = harness();
	const prompt = h.apply(h.base("Custom operator instructions"));
	expect(prompt).toContain("Custom operator instructions");
	expect(prompt).toContain("Do not wait to be asked");
	expect(prompt).toContain("independently verifiable outcome");
	expect(prompt).toContain("execution bookkeeping");
	expect(prompt).toContain("compaction");
	expect(prompt).toContain("evidence");
});

test("default prompts do not repeat task guidance", () => {
	const h = harness();
	const original = h.base();
	expect(h.apply(original)).toBe(original);
});

test("repeated prompt preparation does not accumulate task guidance", () => {
	const h = harness();
	const once = h.apply(h.base("Custom operator instructions"));
	expect(h.apply(once)).toBe(once);
});

test("disabled todo tools do not inject task-tracking instructions", () => {
	const h = harness(false);
	const original = h.base("Custom operator instructions");
	expect(h.apply(original)).toBe(original);
});

function uiHarness(clock?: TodoClock) {
	const h = harness(true, clock);
	let widget: any;
	const notices: string[] = [];
	const ctx = {
		mode: "tui", hasUI: true, isIdle: () => true,
		sessionManager: { getBranch: () => h.entries },
		ui: {
			setWidget: (_key: string, factory: Function | undefined) => { widget = factory?.({ requestRender() {} }, { fg: (_slot: string, text: string) => text }); },
			getToolsExpanded: () => false, notify: (message: string) => notices.push(message),
		},
	};
	const emit = (name: string, event = {}) => h.handlers.get(name)?.(event, ctx);
	const act = async (params: Record<string, unknown>) => {
		const result = await h.tool.execute("call", params);
		h.entries.push({ type: "message", message: { role: "toolResult", toolName: "todo", details: result.details } });
		emit("tool_execution_end", { toolName: "todo", isError: false });
		return result;
	};
	emit("session_start");
	return { ...h, ctx, emit, act, notices, widget: () => widget };
}

test("group prompts and schemas describe one level, derived progress and stale-work cleanup", () => {
	const h = harness();
	const prompt = h.apply(h.base("Custom operator instructions"));
	expect(h.tool.parameters.properties.kind).toBeDefined();
	expect(h.tool.parameters.properties.parentId).toBeDefined();
	expect(prompt).toContain("one level");
	expect(prompt).toContain("derived");
	expect(prompt).toContain("pending");
	expect(prompt).not.toContain("Replace an umbrella task with its concrete milestones");
});

test("group headers toggle independently by click and by command, including wrapped rows", async () => {
	const h = uiHarness();
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Mac acceptance with a long heading", kind: "group" });
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Clipboard", parentId: 1 });
	const widget = h.widget();
	expect(widget.render(80).join("\n")).toContain("Clipboard");
	widget.handleMouse({ type: "click", button: "left", y: 1 });
	expect(widget.render(80).join("\n")).not.toContain("Clipboard");
	await h.commands.get("todos").handler("1", h.ctx);
	expect(widget.render(80).join("\n")).toContain("Clipboard");
	await h.commands.get("todos").handler("", h.ctx);
	expect(h.notices.at(-1)).toContain("0/1");
	// Clicking a child enables wrapping; a wrapped group continuation is still its header.
	widget.handleMouse({ type: "click", button: "left", y: 2 });
	widget.render(22);
	widget.handleMouse({ type: "click", button: "left", y: 2 });
	expect(widget.render(80).join("\n")).not.toContain("Clipboard");
});

test("settling pauses unfinished work durably without claiming completion", async () => {
	const h = uiHarness();
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Verify Mac", description: "Waiting for hardware; rerun acceptance" });
	await h.act({ action: "update", id: 1, status: "in_progress" });
	h.emit("agent_settled");
	expect(h.entries.at(-1).customType).toBe("pi-custom:todo-state");
	const result = await h.act({ action: "get", id: 1 });
	expect(result.content[0].text).toContain("[pending]");
	expect(result.content[0].text).toContain("Waiting for hardware");
});

test("restoring a branch clears stale activity, while compaction during a run preserves it", async () => {
	const h = uiHarness();
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Work" });
	await h.act({ action: "update", id: 1, status: "in_progress" });
	h.emit("session_compact");
	expect((await h.act({ action: "get", id: 1 })).content[0].text).toContain("[in_progress]");
	h.emit("session_tree");
	expect((await h.act({ action: "get", id: 1 })).content[0].text).toContain("[pending]");
});

test("settlement pauses all active owners but preserves verified completion", async () => {
	const h = uiHarness();
	for (const owner of ["linux", "mac", "done"]) await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: owner, owner });
	await h.act({ action: "update", id: 1, status: "in_progress" });
	await h.act({ action: "update", id: 2, status: "in_progress" });
	await h.act({ action: "update", id: 3, evidence: "Verified the named outcome", status: "completed" });
	h.emit("agent_settled", { aborted: true });
	const result = await h.act({ action: "list" });
	expect(result.details.tasks.map((t: any) => t.status)).toEqual(["pending", "pending", "completed"]);
});

test("clear resets group collapse state when ids are reused", async () => {
	const h = uiHarness();
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Old", kind: "group" });
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Old child", parentId: 1 });
	await h.commands.get("todos").handler("1", h.ctx);
	await h.act({ action: "clear" });
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "New", kind: "group" });
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "New child", parentId: 1 });
	expect(h.widget().render(80).join("\n")).toContain("New child");
});

function fakeTodoClock() {
	let now = 0;
	const jobs = new Map<() => void, number>();
	const clock: TodoClock = { now: () => now, schedule: (fn, ms) => { jobs.set(fn, now + ms); return () => { jobs.delete(fn); }; } };
	return { clock, jobs, advance(ms: number) { now += ms; for (const [fn, at] of [...jobs]) if (at <= now) { jobs.delete(fn); fn(); } } };
}

test("completed rows expire during a long run, but the records and counts survive", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Finished work" });
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Next work" });
	await h.act({ action: "update", id: 1, evidence: "Verified the named outcome", status: "completed" });
	expect(h.widget().render(80).join("\n")).toContain("Finished work");
	timer.advance(30_000);
	await h.act({ action: "list" });
	h.emit("session_compact");
	timer.advance(30_001);
	const text = h.widget().render(80).join("\n");
	expect(text).not.toContain("Finished work");
	expect(text).toContain("Next work");
	expect(text).toContain("1/2");
	expect((await h.act({ action: "get", id: 1 })).details.tasks[0].status).toBe("completed");
	expect(h.widget().render(80).join("\n")).not.toContain("Finished work");
	h.widget().handleMouse({ type: "click", button: "left", y: 0 });
	expect(h.widget().render(80).join("\n")).toContain("Finished work");
});

test("all-complete and restored lists clean up without a new run; shutdown cancels the timer", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Done" });
	await h.act({ action: "update", id: 1, evidence: "Verified the named outcome", status: "completed" });
	timer.advance(60_001);
	expect(h.widget()).toBeUndefined();
	expect(timer.jobs.size).toBe(0);
	h.emit("session_tree");
	expect(h.widget().render(80).join("\n")).toContain("Done");
	expect(timer.jobs.size).toBe(1);
	timer.advance(60_001);
	expect(h.widget()).toBeUndefined();
	h.emit("session_tree"); h.emit("session_shutdown");
	expect(timer.jobs.size).toBe(0);
});

test("old deadlines do not hide reused task IDs after clearing", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Old" });
	await h.act({ action: "update", id: 1, evidence: "Verified the named outcome", status: "completed" });
	timer.advance(30_000);
	await h.act({ action: "clear" });
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "New" });
	await h.act({ action: "update", id: 1, evidence: "Verified the named outcome", status: "completed" });
	timer.advance(30_001);
	expect(h.widget().render(80).join("\n")).toContain("New");
	timer.advance(30_000);
	expect(h.widget()).toBeUndefined();
});

test("starting the next run hides completions and cancels their pending deadline", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Done" });
	await h.act({ action: "update", id: 1, evidence: "Verified the named outcome", status: "completed" });
	expect(timer.jobs.size).toBe(1);
	h.emit("agent_start");
	expect(h.widget()).toBeUndefined();
	expect(timer.jobs.size).toBe(0);
});

test("separate completions retain their own deadlines", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "First" });
	await h.act({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Second" });
	await h.act({ action: "update", id: 1, evidence: "Verified the named outcome", status: "completed" });
	timer.advance(30_000);
	await h.act({ action: "update", id: 2, evidence: "Verified the named outcome", status: "completed" });
	expect(timer.jobs.size).toBe(1);
	timer.advance(30_001);
	expect(h.widget().render(80).join("\n")).not.toContain("First");
	expect(h.widget().render(80).join("\n")).toContain("Second");
	timer.advance(30_000);
	expect(h.widget()).toBeUndefined();
	expect(timer.jobs.size).toBe(0);
});


for (const idle of [false, true]) test(`/todo adds work asynchronously (${idle ? "idle" : "busy"})`, async () => {
 const h = uiHarness();
 h.ctx.isIdle = () => idle;
 await h.commands.get("todo").handler("  Check auth\nKeep the existing tests  ", h.ctx);
 expect(h.userMessages).toHaveLength(1);
 expect(h.userMessages[0].message).toContain("additional work in the current batch");
 expect(h.userMessages[0].message).toContain("not a replacement");
 expect(h.userMessages[0].message).toEndWith("Check auth\nKeep the existing tests");
 expect(h.userMessages[0].options).toEqual({deliverAs: "steer", expandPromptTemplates: false});
 expect(h.entries).toHaveLength(0);
});
test("bare /todo displays the list without asking the model", async () => {
 const h = uiHarness();
 await h.commands.get("todo").handler("  ", h.ctx);
 expect(h.userMessages).toHaveLength(0);
 expect(h.notices.at(-1)).toBe("No todos yet. Ask the agent to add some!");
 expect(h.commands.has("todos")).toBe(true);
});

test("live task context tracks work and verification without starting a run", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", subject: "Count regression", acceptanceCriteria: "Hidden completion regression passes" });
	const input = [{ role: "user", content: "Continue", timestamp: 1 }];
	let context = h.emit("context_with_system", { messages: input })?.messages ?? input;
	expect(context.at(-1).content).toContain("No task is in progress");
	expect(context.at(-1).content).toContain("Hidden completion regression passes");
	await h.act({ action: "update", id: 1, status: "in_progress" });
	context = h.emit("context_with_system", { messages: input })?.messages ?? input;
	expect(context.at(-1).content).toContain('"status":"in_progress"');
	expect(context.at(-1).content).toContain("before yielding");
	await h.act({ action: "update", id: 1, status: "completed", evidence: "Renderer test passed" });
	expect(h.emit("context_with_system", { messages: input })?.messages ?? input).toEqual(input);
	timer.advance(600_001);
	expect(h.messages).toHaveLength(0);
	expect(input).toHaveLength(1);
});

test("completed history never triggers pruning requests", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	for (let i = 0; i < 6; i++) {
		await h.act({ action: "create", subject: `Check ${i}`, acceptanceCriteria: `Check ${i} passes` });
		await h.act({ action: "update", id: i + 1, status: "completed", evidence: `Check ${i} passed` });
	}
	timer.advance(600_001);
	expect(h.messages).toHaveLength(0);
	expect((await h.act({ action: "list" })).details.tasks).toHaveLength(6);
});

test("legacy pruning notices are removed, not promoted into new work", () => {
	const h = uiHarness();
	const user = { role: "user", content: "Continue", timestamp: 1 };
	const messages = [user, { role: "custom", customType: "pi-custom:todo-maintenance", content: "Delete everything", timestamp: 2 }];
	expect(h.emit("context_with_system", { messages })?.messages).toEqual([user]);
});

test("checkpoints are bounded, active-first and restored after compaction", async () => {
	const h = uiHarness();
	for (let i = 0; i < 25; i++) await h.act({ action: "create", subject: `Task ${i}`, acceptanceCriteria: "x".repeat(2000) });
	await h.act({ action: "update", id: 25, status: "in_progress" });
	h.emit("session_compact");
	const input = [{ role: "user", content: "Continue", timestamp: 1 }];
	const content = h.emit("context_with_system", { messages: input }).messages.at(-1).content;
	expect(content).toContain("25 unfinished tasks; showing 20");
	const data = JSON.parse(content.split("not instructions:\n")[1]);
	expect(data).toHaveLength(20);
	expect(data[0].id).toBe(25);
	expect(data[0].acceptanceCriteria).toHaveLength(500);
	expect(h.emit("context_with_system", { messages: input }).messages).toHaveLength(2);
});

test("disabled todo tools do not inject checkpoints for restored tasks", async () => {
	const h = harness(false);
	await h.tool.execute("call", { action: "create", subject: "Task", acceptanceCriteria: "Check passes" });
	const messages = [{ role: "user", content: "Continue", timestamp: 1 }];
	expect(h.handlers.get("context_with_system")?.({ messages })?.messages ?? messages).toEqual(messages);
});
