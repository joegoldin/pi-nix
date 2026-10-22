import { describe, expect, it } from "bun:test";
import { bringBackDraft, conversationContext, firstMessage, followUpMessage } from "./btw.ts";

describe("the side model's context", () => {
	it("keeps what was said and what tools were called, not tool output", () => {
		const text = conversationContext([
			{ type: "message", message: { role: "user", content: "fix it" } },
			{
				type: "message",
				message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Looking." }, { type: "toolCall", name: "read", arguments: { path: "a" } }] },
			},
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "secret file body" }] } },
		]);
		expect(text).toBe('User: fix it\n\nAssistant (toolUse): Looking.\nTool call: read({"path":"a"})');
		expect(text).not.toContain("secret file body");
	});

	it("keeps the tail of a long conversation and says it did", () => {
		const text = conversationContext([{ type: "message", message: { role: "user", content: "x".repeat(50_000) } }]);
		expect(text).toStartWith("[Earlier context omitted; showing the last 40000 characters.]");
		expect(text.length).toBeLessThan(40_100);
	});
});

describe("messages", () => {
	it("frames the first question with the context and follow-ups without it", () => {
		expect(firstMessage("why?", "")).toContain("No prior conversation context was available.");
		expect(firstMessage("why?", "ctx")).toContain("<side_question>\nwhy?\n</side_question>");
		expect(followUpMessage("and?")).not.toContain("conversation_context");
	});

	it("brings an answer back as discussion, not as done work", () => {
		const draft = bringBackDraft({ question: "q", answer: "a" });
		expect(draft).toContain("Treat it as discussion context, not as work already completed.");
		expect(draft).toContain("<btw_context>\nUser:\nq\n\nAssistant:\na\n</btw_context>");
	});
});

const { BtwView } = await import("./btw.ts");
const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
initTheme("dark", false);
const plainTheme = { fg: (_slot: string, text: string) => text, bold: (text: string) => text };
function panel() {
	const thread = { id: "t", sessionId: "s", context: "", updatedAt: 0, turns: [{ question: "FIRST QUESTION", answer: Array.from({ length: 40 }, (_, i) => `Answer line ${i}`).join("\n\n") }, { question: "LAST QUESTION", answer: "LAST ANSWER" }] };
	const imports: string[] = [];
	let height = 10;
	const view = new BtwView(thread, plainTheme, async () => {}, (all?: boolean) => imports.push(all ? "all" : "latest"), () => {}, () => {}, () => height);
	return { view, thread, imports, resize: (value: number) => { height = value; } };
}

it("caps the BTW transcript while keeping the composer visible and scrollable", () => {
	const { view, resize } = panel();
	for (const c of "draft question") view.handleInput(c);
	let lines = view.render(80);
	expect(lines.length).toBeLessThanOrEqual(10);
	expect(lines.join("\n")).toContain("LAST ANSWER");
	expect(lines.join("\n")).toContain("draft question");
	view.handleInput("\x1b[1;5H");
	lines = view.render(80);
	expect(lines.join("\n")).toContain("FIRST QUESTION");
	expect(lines.join("\n")).not.toContain("LAST ANSWER");
	expect(lines.join("\n")).toContain("draft question");
	view.handleInput("\x1b[6~");
	expect(view.render(80).join("\n")).not.toContain("FIRST QUESTION");
	view.handleInput("\x1b[1;5F");
	expect(view.render(80).join("\n")).toContain("LAST ANSWER");
	resize(5);
	expect(view.render(35).length).toBeLessThanOrEqual(5);
	expect(view.render(35).join("\n")).toContain("draft question");
});

it("distinguishes Ctrl+Shift+R full-thread import from Ctrl+R latest exchange", () => {
	const { view, imports } = panel();
	view.handleInput("\x1b[114;6u");
	view.handleInput("\x12");
	expect(imports).toEqual(["all", "latest"]);
});

it("full-thread import retains every visible exchange, including failed or unanswered questions", async () => {
	const { bringBackThreadDraft } = await import("./btw.ts");
	const text = bringBackThreadDraft([
		{ question: "First", answer: "One", response: { thinking: "private reasoning" } },
		{ question: "Second", answer: "Two" },
		{ question: "Failed", error: "Unavailable" },
		{ question: "Pending" },
	]);
	expect(text).toContain("User:\nFirst\n\nAssistant:\nOne\n\nUser:\nSecond\n\nAssistant:\nTwo");
	expect(text).toContain("[No answer: Unavailable]");
	expect(text).toContain("User:\nPending\n\nAssistant:\n[No completed answer.]");
	expect(text).not.toContain("private reasoning");
});

it("mouse scrolling preserves the draft and does not jump to the tail on new content", () => {
	const { view, thread } = panel();
	view.handleInput("x"); view.render(80);
	expect(view.handleMouse({ type: "wheel", wheelDelta: -100 } as never)).toMatchObject({ handled: true, render: true });
	expect(view.render(80).join("\n")).toContain("FIRST QUESTION");
	thread.turns.push({ question: "New", answer: "NEW TAIL" });
	expect(view.render(80).join("\n")).toContain("FIRST QUESTION");
	view.handleMouse({ type: "wheel", wheelDelta: 100 } as never);
	expect(view.render(80).join("\n")).toContain("NEW TAIL");
	expect(view.handleMouse({ type: "click", button: "left" } as never)).toBeUndefined();
});

function commandHarness() {
	let command: any, component: any;
	let draft = "Existing main draft";
	const requests: { resolve: (response: unknown) => void; signal: AbortSignal }[] = [];
	const tui = { terminal: { rows: 40 }, requestRender() {} };
	const ctx = {
		mode: "tui", model: { reasoning: false },
		sessionManager: { getSessionId: () => "session", getBranch: () => [{ type: "message", message: { role: "user", content: "BACKGROUND_CONTEXT" } }] },
		modelRegistry: { streamSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => ({ result: () => new Promise((resolve) => requests.push({ resolve, signal: options.signal })) }) },
		ui: {
			getEditorText: () => draft, setEditorText: (text: string) => { draft = text; }, notify() {},
			select: async (_title: string, labels: string[]) => labels[1],
			custom: (factory: Function) => new Promise<void>((resolve) => {
				const original = draft;
				component = factory(tui, plainTheme, {}, () => { draft = original; resolve(); });
			}),
		},
	};
	return { ctx, tui, requests, component: () => component, draft: () => draft, command: () => command,
		api: { registerCommand: (_name: string, value: unknown) => { command = value; }, getThinkingLevel: () => "off", sendMessage: () => { throw new Error("must not submit"); } } };
}
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

it("the real command imports all exchanges after closing, preserves the main draft, and stays height-bounded", async () => {
	const { registerBtw } = await import("./btw.ts");
	const h = commandHarness(); registerBtw(h.api as never);
	const opened = h.command().handler("First question", h.ctx);
	h.requests[0].resolve({ stopReason: "stop", content: [{ type: "text", text: "First answer\n\n".repeat(40) }] });
	await flush();
	for (const c of "Second question") h.component().handleInput(c);
	h.component().handleInput("\r");
	h.requests[1].resolve({ stopReason: "stop", content: [{ type: "text", text: "Second answer" }] });
	await flush();
	expect(h.component().render(80).length).toBeLessThanOrEqual(18);
	h.tui.terminal.rows = 24;
	expect(h.component().render(80).length).toBeLessThanOrEqual(10);
	h.component().handleInput("\x1b[114;6u");
	await opened;
	expect(h.draft()).toStartWith("Existing main draft\n\n");
	for (const text of ["First question", "First answer", "Second question", "Second answer"]) expect(h.draft()).toContain(text);
	expect(h.draft()).not.toContain("BACKGROUND_CONTEXT");
	expect(h.requests).toHaveLength(2);
});

it("importing during a request aborts it without dropping a newer question after resuming", async () => {
	const { registerBtw } = await import("./btw.ts");
	const h = commandHarness(); registerBtw(h.api as never);
	const first = h.command().handler("Old pending question", h.ctx);
	h.component().handleInput("\x1b[114;6u");
	await first;
	expect(h.requests[0].signal.aborted).toBe(true);
	const resumed = h.command().handler("", h.ctx);
	await flush();
	for (const c of "New question") h.component().handleInput(c);
	h.component().handleInput("\r");
	h.requests[0].resolve({ stopReason: "aborted" });
	await flush();
	h.requests[1].resolve({ stopReason: "stop", content: [{ type: "text", text: "New answer" }] });
	await flush();
	h.component().handleInput("\x1b[114;6u");
	await resumed;
	expect(h.draft()).toContain("User:\nNew question\n\nAssistant:\nNew answer");
});

it("keeps BTW controls without the line counter or scrolling hints", () => {
	const { view } = panel();
	const text = view.render(100).join("\n");
	expect(text).not.toMatch(/\d+[–-]\d+\/\d+/);
	expect(text).not.toContain("PgUp/PgDn");
	expect(text).not.toContain("wheel scroll");
	expect(text).not.toContain("Ctrl+Home/End");
	expect(text).toContain("Enter ask · Ctrl+r latest · Ctrl+Shift+r all");
	expect(text).toContain("Esc close");
});
