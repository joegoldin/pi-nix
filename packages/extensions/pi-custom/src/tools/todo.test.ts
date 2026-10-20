import { expect, test } from "bun:test";
import { registerTodo } from "./todo.ts";

// Exercise Pi's prompt builder, not a copy of its custom-prompt behavior.
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

function harness(active = true) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	let tool: any;
	registerTodo({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerTool: (definition: unknown) => { tool = definition; },
		registerCommand: (name: string, command: unknown) => commands.set(name, command), registerShortcut() {},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getActiveTools: () => active ? ["todo"] : [],
	} as never);
	const base = (customPrompt?: string) => buildSystemPrompt({
		cwd: "/tmp", selectedTools: active ? ["todo"] : [], customPrompt,
		toolSnippets: { todo: tool.promptSnippet }, toolGuidelines: { todo: tool.promptGuidelines },
	});
	const apply = (systemPrompt: string) => handlers.get("before_agent_start")?.({ systemPrompt })?.systemPrompt ?? systemPrompt;
	return { tool, base, apply, handlers, commands, entries };
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

function uiHarness() {
	const h = harness();
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
	await h.act({ action: "create", subject: "Mac acceptance with a long heading", kind: "group" });
	await h.act({ action: "create", subject: "Clipboard", parentId: 1 });
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
	await h.act({ action: "create", subject: "Verify Mac", description: "Waiting for hardware; rerun acceptance" });
	await h.act({ action: "update", id: 1, status: "in_progress" });
	h.emit("agent_settled");
	expect(h.entries.at(-1).customType).toBe("pi-custom:todo-state");
	const result = await h.act({ action: "get", id: 1 });
	expect(result.content[0].text).toContain("[pending]");
	expect(result.content[0].text).toContain("Waiting for hardware");
});

test("restoring a branch clears stale activity, while compaction during a run preserves it", async () => {
	const h = uiHarness();
	await h.act({ action: "create", subject: "Work" });
	await h.act({ action: "update", id: 1, status: "in_progress" });
	h.emit("session_compact");
	expect((await h.act({ action: "get", id: 1 })).content[0].text).toContain("[in_progress]");
	h.emit("session_tree");
	expect((await h.act({ action: "get", id: 1 })).content[0].text).toContain("[pending]");
});

test("settlement pauses all active owners but preserves verified completion", async () => {
	const h = uiHarness();
	for (const owner of ["linux", "mac", "done"]) await h.act({ action: "create", subject: owner, owner });
	await h.act({ action: "update", id: 1, status: "in_progress" });
	await h.act({ action: "update", id: 2, status: "in_progress" });
	await h.act({ action: "update", id: 3, status: "completed" });
	h.emit("agent_settled", { aborted: true });
	const result = await h.act({ action: "list" });
	expect(result.details.tasks.map((t: any) => t.status)).toEqual(["pending", "pending", "completed"]);
});

test("clear resets group collapse state when ids are reused", async () => {
	const h = uiHarness();
	await h.act({ action: "create", subject: "Old", kind: "group" });
	await h.act({ action: "create", subject: "Old child", parentId: 1 });
	await h.commands.get("todos").handler("1", h.ctx);
	await h.act({ action: "clear" });
	await h.act({ action: "create", subject: "New", kind: "group" });
	await h.act({ action: "create", subject: "New child", parentId: 1 });
	expect(h.widget().render(80).join("\n")).toContain("New child");
});
