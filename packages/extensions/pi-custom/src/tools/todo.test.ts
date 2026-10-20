import { expect, test } from "bun:test";
import { registerTodo } from "./todo.ts";

// Exercise Pi's prompt builder, not a copy of its custom-prompt behavior.
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

function harness(active = true) {
	const handlers = new Map<string, Function>();
	let tool: any;
	registerTodo({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerTool: (definition: unknown) => { tool = definition; },
		registerCommand() {}, registerShortcut() {},
		getActiveTools: () => active ? ["todo"] : [],
	} as never);
	const base = (customPrompt?: string) => buildSystemPrompt({
		cwd: "/tmp", selectedTools: active ? ["todo"] : [], customPrompt,
		toolSnippets: { todo: tool.promptSnippet }, toolGuidelines: { todo: tool.promptGuidelines },
	});
	const apply = (systemPrompt: string) => handlers.get("before_agent_start")?.({ systemPrompt })?.systemPrompt ?? systemPrompt;
	return { tool, base, apply };
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
