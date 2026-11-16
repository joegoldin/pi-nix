import { expect, test } from "bun:test";
import { registerTodo, type TodoClock } from "./todo.ts";

// Exercise Pi's prompt builder, not a copy of its custom-prompt behavior.
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

function harness(active = true, clock?: TodoClock) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const entries: any[] = [];
	const messages: { message: any; options: any }[] = [];
	const userMessages: {message: string; options: any}[] = [];
	let tool: any;
	registerTodo({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerTool: (definition: unknown) => { tool = definition; },
		registerCommand: (name: string, command: unknown) => commands.set(name, command), registerShortcut: (key: string, shortcut: unknown) => shortcuts.set(key, shortcut),
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
	return { tool, base, apply, handlers, commands, shortcuts, entries, messages, userMessages };
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
	let renderRequests = 0;
	const notices: string[] = [];
	const ctx = {
		mode: "tui", hasUI: true, isIdle: () => true,
		sessionManager: { getBranch: () => h.entries },
		ui: {
			setWidget: (_key: string, factory: Function | undefined) => { widget = factory?.({ requestRender() { renderRequests++; } }, { fg: (_slot: string, text: string) => text }); },
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
	return { ...h, ctx, emit, act, notices, widget: () => widget, renderRequests: () => renderRequests };
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

test("todo clicks leave focus, preview, full and group scoping unchanged", async () => {
	const h = uiHarness();
	await h.act({ action: "create", subject: "Group", kind: "group" });
	await h.act({ action: "create", acceptanceCriteria: "Verified", subject: "Child", parentId: 1 });
	await h.act({ action: "create", acceptanceCriteria: "Verified", subject: "Other" });
	const widget = h.widget();
	for (let view = 0; view < 3; view++) {
		for (const width of [22, 80]) {
			const before = widget.render(width);
			for (let y = 0; y < before.length; y++) {
				widget.handleMouse?.({ type: "click", button: "left", y });
				expect(widget.render(width)).toEqual(before);
			}
		}
		await h.shortcuts.get("ctrl+alt+t").handler();
	}
	await h.commands.get("todos").handler("1", h.ctx);
	expect(widget.render(80).join("\n")).not.toContain("Child");
	await h.commands.get("todos").handler("1", h.ctx);
	expect(widget.render(80).join("\n")).toContain("Child");
	await h.commands.get("todos").handler("", h.ctx);
	expect(h.notices.at(-1)).toContain("0/2");
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
	let now = 0, nextId = 1;
	const jobs = new Map<number, { at: number; callback: () => void }>();
	const clock: TodoClock = {
		now: () => now,
		schedule(callback, delay) {
			const id = nextId++;
			jobs.set(id, { at: now + delay, callback });
			return () => { jobs.delete(id); };
		},
	};
	return { clock, jobs, advance(ms: number) {
		const target = now + ms;
		while (true) {
			const due = [...jobs.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			now = due[1].at; jobs.delete(due[0]); due[1].callback();
		}
		now = target;
	} };
}

test("completion moves below work into a separate recent section without changing overall progress", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", subject: "Finished work", acceptanceCriteria: "Verified" });
	await h.act({ action: "create", subject: "Next work", acceptanceCriteria: "Verified" });
	await h.act({ action: "update", id: "a", status: "completed", evidence: "Passed" });
	for (let view = 0; view < 3; view++) {
		const text = h.widget().render(100).join("\n");
		expect(text.split("Recently completed")[0]).not.toContain("Finished work");
		expect(text).toContain("Finished work");
		expect(text.indexOf("Next work")).toBeLessThan(text.indexOf("Recently completed"));
		expect(text).toContain("Next work");
		expect(text).toContain("1/2");
		await h.shortcuts.get("ctrl+alt+t").handler();
	}
	timer.advance(600_001); h.emit("session_compact");
	expect(h.widget().render(100).join("\n")).not.toContain("Finished work");
	expect((await h.act({ action: "get", id: "a" })).content[0].text).toContain("evidence: Passed");
});

for (const event of ["session_start", "session_tree", "session_compact"]) test(`${event} retains recent completions only for their original five-minute window`, async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", subject: "Done", acceptanceCriteria: "Verified" });
	await h.act({ action: "update", id: "a", status: "completed", evidence: "Passed" });
	expect(h.widget().render(100).join("\n")).toContain("Done");
	timer.advance(299_999);
	h.emit(event);
	expect(h.widget().render(100).join("\n")).toContain("Done");
	expect([...timer.jobs.values()].map(job => job.at)).toEqual([300_000]);
	timer.advance(1);
	expect(h.widget()).toBeUndefined();
	for (let view = 0; view < 3; view++) {
		await h.shortcuts.get("ctrl+alt+t").handler();
		expect(h.widget()).toBeUndefined();
	}
	await h.commands.get("todos").handler("history", h.ctx);
	expect(h.notices.at(-1)).toContain("#a Done");
	expect(h.messages).toHaveLength(0);
});

test("clear resets group view state without leaving completion deadlines on reused ids", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", subject: "Old", acceptanceCriteria: "Verified" });
	await h.act({ action: "update", id: "a", status: "completed", evidence: "Passed" });
	await h.act({ action: "clear" });
	await h.act({ action: "create", subject: "New", acceptanceCriteria: "Verified" });
	timer.advance(600_001);
	expect(h.widget().render(100).join("\n")).toContain("New");
	expect((await h.act({ action: "history" })).content[0].text).toBe("No task history");
});

test("completed and archived tasks share history, but only recent completions appear below work", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	for (const subject of ["Finished", "Superseded", "Next"]) await h.act({ action: "create", subject, acceptanceCriteria: "Verified" });
	await h.act({ action: "update", id: "a", status: "completed", evidence: "Passed" });
	await h.act({ action: "delete", id: "b", description: "No longer needed" });
	await h.commands.get("todos").handler("", h.ctx);
	expect(h.notices.at(-1)).toContain("Next");
	expect(h.notices.at(-1)).toContain("Recently completed");
	expect(h.notices.at(-1)).toContain("Finished");
	expect(h.notices.at(-1)).not.toContain("Superseded");
	await h.commands.get("todos").handler("history", h.ctx);
	expect(h.notices.at(-1)).toContain("Finished");
	expect(h.notices.at(-1)).toContain("Superseded");
	expect(h.notices.at(-1)).not.toContain("Next");
	await h.act({ action: "delete", id: "c" });
	timer.advance(300_000);
	await h.commands.get("todos").handler("", h.ctx);
	expect(h.notices.at(-1)).toContain("/todos history");
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
	expect(data[0].id).toBe("y");
	expect(data[0].acceptanceCriteria).toHaveLength(500);
	expect(h.emit("context_with_system", { messages: input }).messages).toHaveLength(2);
});

test("disabled todo tools do not inject checkpoints for restored tasks", async () => {
	const h = harness(false);
	await h.tool.execute("call", { action: "create", subject: "Task", acceptanceCriteria: "Check passes" });
	const messages = [{ role: "user", content: "Continue", timestamp: 1 }];
	expect(h.handlers.get("context_with_system")?.({ messages })?.messages ?? messages).toEqual(messages);
});

function checkpoint(h: ReturnType<typeof uiHarness>): string {
	return h.emit("context_with_system", { messages: [] })?.messages.at(-1)?.content ?? "";
}

test("six model turns require a full-list review, not just another task update", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", subject: "Work", acceptanceCriteria: "Tests pass" });
	await h.act({ action: "list" });
	for (let i = 0; i < 5; i++) h.emit("turn_end");
	expect(checkpoint(h)).not.toContain("Todo review due");
	h.emit("turn_end");
	expect(checkpoint(h)).toContain("Todo review due");
	await h.act({ action: "update", id: 1, description: "Still working" });
	await h.act({ action: "get", id: 1 });
	await h.act({ action: "list", status: "in_progress" });
	expect(checkpoint(h)).toContain("Todo review due");
	await h.act({ action: "list" });
	expect(checkpoint(h)).not.toContain("Todo review due");
});

test("two minutes require review at the next request without timers or idle wakeups", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", subject: "Work", acceptanceCriteria: "Tests pass" });
	await h.act({ action: "list" });
	timer.advance(119_999);
	expect(checkpoint(h)).not.toContain("Todo review due");
	timer.advance(1);
	expect(checkpoint(h)).toContain("Todo review due");

	expect(h.messages).toHaveLength(0);
	expect(h.userMessages).toHaveLength(0);
	await h.act({ action: "list" });
	expect(checkpoint(h)).not.toContain("Todo review due");
});

for (const event of ["session_start", "session_compact", "session_tree"]) test(`${event} requires fresh reconciliation of restored tasks`, async () => {
	const h = uiHarness(fakeTodoClock().clock);
	await h.act({ action: "create", subject: "Work", acceptanceCriteria: "Tests pass" });
	await h.act({ action: "list" });
	h.emit(event);
	expect(checkpoint(h)).toContain("Todo review due");
	expect(checkpoint(h)).toContain("todo list");
	expect(checkpoint(h)).toContain("Do not delete");
	await h.act({ action: "list" });
	expect(checkpoint(h)).not.toContain("Todo review due");
});

test("clearing a batch resets cadence and completed-only batches do not demand review", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", subject: "Old", acceptanceCriteria: "Tests pass" });
	timer.advance(120_000);
	expect(checkpoint(h)).toContain("Todo review due");
	await h.act({ action: "clear" });
	await h.act({ action: "create", subject: "New", acceptanceCriteria: "Tests pass" });
	expect(checkpoint(h)).not.toContain("Todo review due");
	await h.act({ action: "update", id: 1, status: "completed", evidence: "Tests passed" });
	timer.advance(120_000);
	expect(checkpoint(h)).toBe("");
});

test("working lists stay bounded across completions and restoration while history survives", async () => {
	const h = uiHarness(fakeTodoClock().clock);
	for (let i = 0; i < 20; i++) {
		await h.act({ action: "create", subject: `Finished ${i}`, acceptanceCriteria: "Check passes" });
		await h.act({ action: "update", id: i + 1, status: "completed", evidence: "Check passed" });
	}
	await h.act({ action: "create", subject: "Remaining", acceptanceCriteria: "Acceptance passes", blockedBy: [20] });
	h.emit("session_tree");
	expect((await h.act({ action: "list" })).content[0].text).toBe("[pending] #u Remaining ⛓ #t");
	expect((await h.act({ action: "list", status: "completed" })).content[0].text.split("\n")).toHaveLength(20);
	expect((await h.act({ action: "get", id: 20 })).content[0].text).toContain("evidence: Check passed");
	expect(h.tool.description).toContain("unfinished tasks by default");
	expect(h.apply(h.base("Custom instructions"))).toContain("up to 3 recent completions from the last 5 minutes");
});


test("Ctrl+Alt+T cycles default five-task preview, full, minimal, then preview", async () => {
 const h = uiHarness();
 for (let i = 1; i <= 8; i++) await h.act({ action: "create", subject: `Work ${i}`, acceptanceCriteria: "Verified" });
 await h.act({ action: "update", id: 6, status: "in_progress" });
 const widget = h.widget();
 const text = () => widget.render(100).join("\n");
 expect(text()).toContain("Work 6");
 expect(text().match(/Work \d/g)).toHaveLength(5);
 await h.shortcuts.get("ctrl+alt+t").handler();
 expect(text().match(/Work \d/g)).toHaveLength(8);
 await h.shortcuts.get("ctrl+alt+t").handler();
 expect(text().match(/Work \d/g)).toHaveLength(1);
 expect(text()).not.toContain("Work 1");
 expect(widget.render(100).length).toBeLessThanOrEqual(3);
 await h.shortcuts.get("ctrl+alt+t").handler();
 expect(text().match(/Work \d/g)).toHaveLength(5);
});


test("focus view retains expired completed dependency evidence outside the visible tasks", async () => {
 const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
 await h.act({ action: "create", subject: "Prerequisite", acceptanceCriteria: "Verified" });
 await h.act({ action: "create", subject: "Dependent", acceptanceCriteria: "Verified", blockedBy: [1] });
 await h.act({ action: "update", id: 1, status: "completed", evidence: "Passed" });
 timer.advance(300_000);
 await h.act({ action: "update", id: 2, status: "in_progress" });
 await h.shortcuts.get("ctrl+alt+t").handler();
 await h.shortcuts.get("ctrl+alt+t").handler();
 const text = h.widget().render(100).join("\n");
 expect(text).toContain("Dependent");
 expect(text).not.toContain("Prerequisite");
 expect(text).not.toContain("⛓");
});

test("Ctrl+O expands locally collapsed todo groups and restores the local view afterward", async () => {
	const h = uiHarness();
	let full = false;
	h.ctx.ui.getToolsExpanded = () => full;
	await h.act({ action: "create", subject: "Group", kind: "group" });
	await h.act({ action: "create", subject: "Child task", parentId: 1, acceptanceCriteria: "Verified child outcome" });
	await h.commands.get("todos").handler("1", h.ctx);
	expect(h.widget().render(100).join("\n")).not.toContain("Child task");
	full = true;
	expect(h.widget().render(100).join("\n")).toContain("Child task");
	full = false;
	expect(h.widget().render(100).join("\n")).not.toContain("Child task");
});

test("overall todo counts stay 5/14 across focus, preview, full and Ctrl+O after completed rows enter history", async () => {
	let overall = "";
	const timer = fakeTodoClock();
	const h = uiHarness(timer.clock);
	Object.assign(h.ctx.ui, { setProgramStatus: (_key: string, status?: { message?: string }) => { overall = status?.message ?? ""; } });
	let expanded = false;
	h.ctx.ui.getToolsExpanded = () => expanded;
	for (let i = 1; i <= 14; i++) await h.act({ action: "create", subject: `Work ${i}`, acceptanceCriteria: "Verified" });
	await h.act({ action: "create", subject: "Heading", kind: "group" });
	await h.act({ action: "create", subject: "Discarded", acceptanceCriteria: "Verified" });
	await h.act({ action: "delete", id: 16 });
	for (let i = 1; i <= 5; i++) await h.act({ action: "update", id: i, status: "completed", evidence: "Passed" });
	timer.advance(60_001);
	const widget = h.widget();
	for (let view = 0; view < 3; view++) {
		for (const width of [40, 100]) expect(widget.render(width)[0]).toContain("5/14");
		await h.shortcuts.get("ctrl+alt+t").handler();
	}
	expanded = true;
	expect(widget.render(100)[0]).toContain("5/14");
	expanded = false;
	expect(widget.render(100)[0]).toContain("5/14");
	await h.act({ action: "list" });
	expect(overall).toBe("5/14 tasks completed");
});

for (const event of ["session_start", "session_tree", "session_compact"]) {
	test(`${event} restores the five-task preview default`, async () => {
		const h = uiHarness();
		for (let i = 1; i <= 8; i++) await h.act({ action: "create", subject: `Work ${i}`, acceptanceCriteria: "Verified" });
		await h.shortcuts.get("ctrl+alt+t").handler();
		expect(h.widget().render(100).join("\n").match(/Work \d/g)).toHaveLength(8);
		h.emit(event);
		expect(h.widget().render(100).join("\n").match(/Work \d/g)).toHaveLength(5);
	});
}

test("expanded and restored widgets keep only three recent completions separate from full history", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	let expanded = false; h.ctx.ui.getToolsExpanded = () => expanded;
	for (let i = 1; i <= 30; i++) {
		await h.act({ action: "create", subject: `Completed item ${i}`, acceptanceCriteria: "Verified" });
		await h.act({ action: "update", id: i, status: "completed", evidence: `Passed ${i}` });
	}
	await h.act({ action: "create", subject: "Current task", acceptanceCriteria: "Verified" });
	for (const event of ["session_start", "session_compact", "session_tree"]) {
		h.emit(event);
		for (const full of [false, true]) {
			expanded = full;
			const text = h.widget().render(100).join("\n");
			expect(text).toContain("Current task");
			expect(text.match(/Completed item/g)).toHaveLength(3);
			for (const id of [28, 29, 30]) expect(text).toContain(`Completed item ${id}`);
		}
	}
	timer.advance(300_000);
	expect(h.widget().render(100).join("\n")).not.toContain("Completed item");

	await h.commands.get("todos").handler("history", h.ctx);
	expect(h.notices.at(-1)).toContain("Completed item 30");
	expect(h.notices.at(-1)).not.toContain("Current task");
	expect((await h.act({ action: "get", id: 30 })).content[0].text).toContain("Passed 30");
});

test("alphabetical group commands and model checkpoints share the tool's ids", async () => {
	const h = uiHarness();
	await h.act({ action: "create", subject: "Batch", kind: "group" });
	await h.act({ action: "create", subject: "Child", parentId: "a", acceptanceCriteria: "Verified" });
	await h.commands.get("todos").handler("a", h.ctx);
	expect(h.widget().render(100).join("\n")).toContain("#a Batch");
	expect(h.widget().render(100).join("\n")).not.toContain("Child");
	await h.commands.get("todos").handler("a", h.ctx);
	expect(h.widget().render(100).join("\n")).toContain("#b Child");
	const data = JSON.parse(checkpoint(h).split("not instructions:\n")[1]);
	expect(data[0].id).toBe("b");
});

test("Pi validates alphabetical links and legacy references against the registered schema", async () => {
	const { validateToolArguments } = await import("@earendil-works/pi-ai");
	const h = uiHarness();
	for (const id of ["a", "z", "aa", "ab", 1, 27]) {
		const args = { action: "update", id, parentId: "b", addBlockedBy: ["z", 27], removeBlockedBy: ["c"], description: "Progress" };
		expect(validateToolArguments(h.tool, { type: "toolCall", id: "call", name: "todo", arguments: args })).toEqual(args);
	}
	for (const id of ["", "a-b", -1]) expect(() => validateToolArguments(h.tool, { type: "toolCall", id: "call", name: "todo", arguments: { action: "get", id } })).toThrow();
	await h.act({ action: "create", subject: "Do not change", acceptanceCriteria: "Verified" });
	for (const id of [1.5, "1.5"]) {
		const args = validateToolArguments(h.tool, { type: "toolCall", id: "call", name: "todo", arguments: { action: "update", id, subject: "Wrong target" } });
		const result = await h.act(args);
		expect(result.details.error).toContain("alphabetical");
		expect(result.details.tasks[0].subject).toBe("Do not change");
	}
	// Pi coerces numeric strings in legacy calls before the tool receives them.
	expect(validateToolArguments(h.tool, { type: "toolCall", id: "call", name: "todo", arguments: { action: "get", id: "1" } })).toEqual({ action: "get", id: 1 });
	expect(validateToolArguments(h.tool, { type: "toolCall", id: "call", name: "todo", arguments: { action: "history" } })).toEqual({ action: "history" });
});

test("alphabetical calls render the selected task, including saved numeric calls", async () => {
	const h = uiHarness();
	const theme = { fg: (_slot: string, value: string) => value, bold: (value: string) => value };
	await h.act({ action: "create", subject: "Selected task", acceptanceCriteria: "Verified" });
	for (const id of ["a", 1]) {
		const call = h.tool.renderCall({ action: "update", id }, theme);
		expect(call.render(100).join("\n")).toContain("Selected task");
		const result = await h.act({ action: "update", id, status: "completed", evidence: "Passed" });
		expect(h.tool.renderResult(result, { expanded: false }, theme).render(100).join("\n")).toContain("completed");
	}
	const history = await h.act({ action: "history" });
	expect(h.tool.renderResult(history, { expanded: true }, theme).render(100).join("\n")).toContain("#a Selected task");
});

for (const event of ["session_start", "session_tree", "session_compact"]) test(`${event} preserves the original completion time, not the restore time`, async () => {
	const timer = fakeTodoClock(); timer.advance(10_000);
	const h = uiHarness(timer.clock);
	await h.act({ action: "create", subject: "Verified", acceptanceCriteria: "Pass" });
	const done = await h.act({ action: "update", id: "a", status: "completed", evidence: "Passed" });
	expect(done.details.tasks[0].completedAt).toBe(10_000);
	timer.advance(250_000); h.emit(event);
	const restored = await h.act({ action: "get", id: "a" });
	expect(restored.details.tasks[0].completedAt).toBe(10_000);
	const edited = await h.act({ action: "update", id: "a", description: "Retain evidence" });
	expect(edited.details.tasks[0].completedAt).toBe(10_000);
	expect(edited.details.tasks[0].evidence).toBe("Passed");
});

test("recent completions are capped across local/global expansion and expire while idle without model work", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	for (let i = 0; i < 6; i++) {
		if (i) timer.advance(10_000);
		await h.act({ action: "create", subject: `Completed check ${i}`, acceptanceCriteria: "Verified" });
		await h.act({ action: "update", id: i + 1, status: "completed", evidence: "Passed" });
	}
	const entries = h.entries.length;
	for (let view = 0; view < 3; view++) {
		for (const expanded of [false, true]) {
			h.ctx.ui.getToolsExpanded = () => expanded;
			const text = h.widget()?.render(100).join("\n");
			expect(text).toContain("Recently completed");
			expect(text).not.toContain("0 shown");
			for (let i = 0; i < 6; i++) {
				if (i >= 3) expect(text).toContain(`Completed check ${i}`);
				else expect(text).not.toContain(`Completed check ${i}`);
			}
			expect(text.indexOf("Completed check 5")).toBeLessThan(text.indexOf("Completed check 4"));
		}
		h.ctx.ui.getToolsExpanded = () => false;
		await h.shortcuts.get("ctrl+alt+t").handler();
	}
	expect(timer.jobs.size).toBe(1);
	timer.advance(279_999);
	expect(h.widget().render(100).join("\n")).toContain("Completed check 3");
	timer.advance(1);
	expect(h.widget().render(100).join("\n")).not.toContain("Completed check 3");
	timer.advance(20_000);
	expect(h.widget()).toBeUndefined();
	expect(timer.jobs.size).toBe(0);
	expect(h.entries).toHaveLength(entries);
	expect(h.messages).toHaveLength(0);
	expect(h.userMessages).toHaveLength(0);
	expect(h.emit("context_with_system", { messages: [] })?.messages ?? []).toEqual([]);
	await h.commands.get("todos").handler("history", h.ctx);
	expect(h.notices.at(-1)).toContain("Completed check 0");
	expect(h.notices.at(-1)).toContain("Completed check 5");
});

test("archiving, clearing and shutdown cancel expiry without affecting reused task ids", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	await h.act({ action: "create", subject: "Old", acceptanceCriteria: "Verified" });
	await h.act({ action: "update", id: "a", status: "completed", evidence: "Passed" });
	expect(timer.jobs.size).toBe(1);
	await h.act({ action: "delete", id: "a" });
	expect(h.widget()).toBeUndefined();
	expect(timer.jobs.size).toBe(0);
	await h.act({ action: "clear" });
	await h.act({ action: "create", subject: "New", acceptanceCriteria: "Verified" });
	await h.act({ action: "update", id: "a", status: "completed", evidence: "Passed" });
	expect(timer.jobs.size).toBe(1);
	await h.act({ action: "clear" });
	await h.act({ action: "create", subject: "Current", acceptanceCriteria: "Verified" });
	timer.advance(300_001);
	expect(h.widget().render(100).join("\n")).toContain("Current");
	await h.act({ action: "update", id: "a", status: "completed", evidence: "Passed" });
	expect(timer.jobs.size).toBe(1);
	h.emit("session_shutdown");
	expect(timer.jobs.size).toBe(0);
});

test("expiry actively redraws a remaining working list without persisting or sending messages", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	for (const subject of ["Verified", "Still pending"]) await h.act({ action: "create", subject, acceptanceCriteria: "Pass" });
	await h.act({ action: "update", id: "a", status: "completed", evidence: "Passed" });
	const widget = h.widget(), renders = h.renderRequests(), entries = h.entries.length;
	timer.advance(299_999);
	expect(h.renderRequests()).toBe(renders);
	timer.advance(1);
	expect(h.renderRequests()).toBeGreaterThan(renders);
	expect(h.widget()).toBe(widget);
	expect(widget.render(100).join("\n")).toContain("Still pending");
	expect(widget.render(100).join("\n")).not.toContain("Recently completed");
	expect(h.entries).toHaveLength(entries);
	expect(h.messages).toHaveLength(0);
	expect(h.userMessages).toHaveLength(0);
});

test("non-TUI sessions persist completion times but do not schedule widget expiry", async () => {
	const timer = fakeTodoClock(); const h = uiHarness(timer.clock);
	Object.assign(h.ctx, { mode: "rpc" });
	await h.act({ action: "create", subject: "Verified", acceptanceCriteria: "Pass" });
	const result = await h.act({ action: "update", id: "a", status: "completed", evidence: "Passed" });
	expect(result.details.tasks[0].completedAt).toBe(0);
	expect(timer.jobs.size).toBe(0);
	expect(h.widget()).toBeUndefined();
});
