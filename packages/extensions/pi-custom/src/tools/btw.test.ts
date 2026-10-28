import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
const temporaryDirectories: string[] = [];
afterEach(() =>
	temporaryDirectories
		.splice(0)
		.forEach((path) => rmSync(path, { recursive: true, force: true })),
);
import { bringBackDraft } from "./btw.ts";

it("brings an answer back as discussion, not as done work", () => {
	const draft = bringBackDraft({ question: "q", answer: "a" });
	expect(draft).toContain(
		"Treat it as discussion context, not as work already completed.",
	);
	expect(draft).toContain(
		"<btw_context>\nUser:\nq\n\nAssistant:\na\n</btw_context>",
	);
});

const { BtwView } = await import("./btw.ts");
const { initTheme } = await import(
	new URL(
		"./modes/interactive/theme/theme.js",
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	).href
);
initTheme("dark", false);
const plainTheme = {
	fg: (_slot: string, text: string) => text,
	bold: (text: string) => text,
};
function panel() {
	const thread = {
		id: "t",
		sessionId: "s",
		context: "",
		updatedAt: 0,
		turns: [
			{
				question: "FIRST QUESTION",
				answer: Array.from({ length: 40 }, (_, i) => `Answer line ${i}`).join(
					"\n\n",
				),
			},
			{ question: "LAST QUESTION", answer: "LAST ANSWER" },
		],
	};
	const imports: string[] = [];
	let height = 10;
	const view = new BtwView(
		thread,
		plainTheme,
		async () => {},
		(all?: boolean) => imports.push(all ? "all" : "latest"),
		() => {},
		() => {},
		() => height,
	);
	return {
		view,
		thread,
		imports,
		resize: (value: number) => {
			height = value;
		},
	};
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
		{
			question: "First",
			answer: "One",
			response: { thinking: "private reasoning" },
		},
		{ question: "Second", answer: "Two" },
		{ question: "Failed", error: "Unavailable" },
		{ question: "Pending" },
	]);
	expect(text).toContain(
		"User:\nFirst\n\nAssistant:\nOne\n\nUser:\nSecond\n\nAssistant:\nTwo",
	);
	expect(text).toContain("[No answer: Unavailable]");
	expect(text).toContain(
		"User:\nPending\n\nAssistant:\n[No completed answer.]",
	);
	expect(text).not.toContain("private reasoning");
});

it("mouse scrolling preserves the draft and does not jump to the tail on new content", () => {
	const { view, thread } = panel();
	view.handleInput("x");
	view.render(80);
	expect(
		view.handleMouse({ type: "wheel", wheelDelta: -100 } as never),
	).toMatchObject({ handled: true, render: true });
	expect(view.render(80).join("\n")).toContain("FIRST QUESTION");
	thread.turns.push({ question: "New", answer: "NEW TAIL" });
	expect(view.render(80).join("\n")).toContain("FIRST QUESTION");
	view.handleMouse({ type: "wheel", wheelDelta: 100 } as never);
	expect(view.render(80).join("\n")).toContain("NEW TAIL");
	expect(
		view.handleMouse({ type: "click", button: "left" } as never),
	).toBeUndefined();
});

function commandHarness() {
	let shutdown: (() => Promise<void>) | undefined;
	const cwd = mkdtempSync(join(tmpdir(), "btw-command-"));
	temporaryDirectories.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	manager.appendMessage({
		role: "user",
		content: "BACKGROUND_CONTEXT",
		timestamp: 1,
	});
	let command: any, component: any;
	let draft = "Existing main draft";
	const requests: {
		resolve: (response: unknown) => void;
		signal: AbortSignal;
	}[] = [];
	const tui = { terminal: { rows: 40 }, requestRender() {} };
	const ctx = {
		cwd,
		mode: "tui",
		model: { reasoning: false },
		sessionManager: manager,
		ui: {
			getEditorText: () => draft,
			setEditorText: (text: string) => {
				draft = text;
			},
			notify() {},
			select: async (_title: string, labels: string[]) => labels.at(-1),
			custom: (factory: Function) =>
				new Promise<void>((resolve) => {
					const original = draft;
					component = factory(tui, plainTheme, {}, () => {
						draft = original;
						resolve();
					});
				}),
		},
	};
	const createRuntime = async (
		_pi: unknown,
		_ctx: unknown,
		child: SessionManager,
	) => {
		let controller: AbortController;
		let listener: (event: any) => void = () => {};
		return {
			subscribe: (fn: (event: any) => void) => {
				listener = fn;
				return () => {};
			},
			prompt: (question: string) => {
				child.appendMessage({
					role: "user",
					content: question,
					timestamp: Date.now(),
				});
				listener({ type: "message_end" });
				controller = new AbortController();
				return new Promise<void>((resolve) =>
					requests.push({
						signal: controller.signal,
						resolve: (response) => {
							child.appendMessage({
								role: "assistant",
								content: [],
								...(response as object),
								timestamp: Date.now(),
							} as any);
							resolve();
						},
					}),
				);
			},
			abort: async () => controller?.abort(),
			extensionRunner: { emit: async () => {} },
			dispose() {},
		};
	};
	return {
		ctx,
		tui,
		requests,
		createRuntime,
		shutdown: () => shutdown?.(),
		component: () => component,
		draft: () => draft,
		command: () => command,
		api: {
			appendEntry: (type: string, data: unknown) =>
				manager.appendCustomEntry(type, data),
			on(name: string, callback: () => Promise<void>) {
				if (name === "session_shutdown") shutdown = callback;
			},
			registerCommand: (_name: string, value: unknown) => {
				command = value;
			},
			getThinkingLevel: () => "off",
			sendMessage: () => {
				throw new Error("must not submit");
			},
		},
	};
}
async function flush() {
	for (let i = 0; i < 15; i++) await Promise.resolve();
}

it("the real command imports all exchanges after closing, preserves the main draft, and stays height-bounded", async () => {
	const { registerBtw } = await import("./btw.ts");
	const h = commandHarness();
	registerBtw(h.api as never, h.createRuntime as never);
	const opened = h.command().handler("First question", h.ctx);
	await flush();
	h.requests[0].resolve({
		stopReason: "stop",
		content: [{ type: "text", text: "First answer\n\n".repeat(40) }],
	});
	await flush();
	for (const c of "Second question") h.component().handleInput(c);
	h.component().handleInput("\r");
	await flush();
	h.requests[1].resolve({
		stopReason: "stop",
		content: [{ type: "text", text: "Second answer" }],
	});
	await flush();
	expect(h.component().render(80).length).toBeLessThanOrEqual(36);
	h.tui.terminal.rows = 24;
	expect(h.component().render(80).length).toBeLessThanOrEqual(21);
	h.component().handleInput("\x1b[114;6u");
	await opened;
	expect(h.draft()).toStartWith("Existing main draft\n\n");
	for (const text of [
		"First question",
		"First answer",
		"Second question",
		"Second answer",
	])
		expect(h.draft()).toContain(text);
	expect(h.draft()).not.toContain("BACKGROUND_CONTEXT");
	expect(h.requests).toHaveLength(2);
});

it("importing during a request aborts it without dropping a newer question after resuming", async () => {
	const { registerBtw } = await import("./btw.ts");
	const h = commandHarness();
	registerBtw(h.api as never, h.createRuntime as never);
	const first = h.command().handler("Old pending question", h.ctx);
	await flush();
	h.component().handleInput("\x1b[114;6u");
	await first;
	expect(h.requests[0].signal.aborted).toBe(true);
	const resumed = h.command().handler("", h.ctx);
	await flush();
	for (const c of "New question") h.component().handleInput(c);
	h.component().handleInput("\r");
	expect(h.requests).toHaveLength(1);
	h.requests[0].resolve({ stopReason: "aborted" });
	await flush();
	// Keep the draft while the previous turn is still settling.
	h.component().handleInput("\r");
	await flush();
	h.requests[1].resolve({
		stopReason: "stop",
		content: [{ type: "text", text: "New answer" }],
	});
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

it("Ctrl+C returns from BTW without aborting its request or allowing a second concurrent turn", async () => {
	const thread = {
		id: "t",
		sessionId: "s",
		context: "",
		updatedAt: 0,
		turns: [],
	};
	let closed = 0,
		requests = 0,
		signal!: AbortSignal,
		finish!: () => void;
	const ask = async (_question: string, requestSignal: AbortSignal) => {
		requests++;
		signal = requestSignal;
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
	};
	const makeView = () =>
		new BtwView(
			thread,
			plainTheme,
			ask,
			() => {},
			() => {
				closed++;
			},
			() => {},
		);
	const first = makeView();
	first.start("Still running");
	first.handleInput("\x03");
	expect(closed).toBe(1);
	expect(signal.aborted).toBe(false);
	const reopened = makeView();
	reopened.handleInput("Next question");
	reopened.handleInput("\r");
	expect(requests).toBe(1);
	finish();
	await flush();
	reopened.handleInput("\r");
	expect(requests).toBe(2);
	finish();
	await flush();
});

it("resumes streamed work after closing and restores a private draft after registration restarts", async () => {
	const { registerBtw } = await import("./btw.ts");
	const h = commandHarness();
	registerBtw(h.api as never, h.createRuntime as never);
	const mainBefore = JSON.stringify(
		h.ctx.sessionManager.buildSessionContext().messages,
	);
	const first = h.command().handler("Private question", h.ctx);
	await flush();
	h.component().handleInput("Private unsent draft");
	h.component().handleInput("\x03");
	await first;
	expect(h.requests[0].signal.aborted).toBe(false);
	expect(h.draft()).toBe("Existing main draft");
	h.requests[0].resolve({
		stopReason: "stop",
		content: [{ type: "text", text: "Private answer" }],
	});
	await flush();
	registerBtw(h.api as never, h.createRuntime as never);
	const resumed = h.command().handler("list", h.ctx);
	await flush();
	const text = h
		.component()
		.render(100)
		.join("\n")
		.replace(/\x1b_pi:[^\x07]*\x07/g, "");
	expect(text).toContain("Private answer");
	expect(text).toContain("Private unsent draft");
	h.component().handleInput("\x03");
	await resumed;
	expect(
		JSON.stringify(h.ctx.sessionManager.buildSessionContext().messages),
	).toBe(mainBefore);
});

it("shutdown disposes a late-initializing child without starting its pending prompt", async () => {
	const { registerBtw } = await import("./btw.ts");
	const h = commandHarness();
	let release!: () => void,
		disposed = false;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const factory = async (...args: Parameters<typeof h.createRuntime>) => {
		await gate;
		const child = await h.createRuntime(...args);
		child.dispose = () => {
			disposed = true;
		};
		return child;
	};
	registerBtw(h.api as never, factory as never);
	const opened = h.command().handler("Pending initialization", h.ctx);
	await flush();
	h.component().handleInput("\x03");
	await opened;
	await h.shutdown();
	release();
	await flush();
	expect(h.requests).toHaveLength(0);
	expect(disposed).toBe(true);
});

it("keeps a long side-conversation title within the native overlay width", async () => {
	const { registerBtw } = await import("./btw.ts");
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const h = commandHarness();
	registerBtw(h.api as never, h.createRuntime as never);
	const opened = h.command().handler("Long question ".repeat(10), h.ctx);
	await flush();
	h.requests[0].resolve({ stopReason: "stop", content: [] });
	await flush();
	const rows = h.component().render(35);
	h.component().handleInput("\x03");
	await opened;
	expect(rows.every((row: string) => visibleWidth(row) <= 35)).toBe(true);
});
