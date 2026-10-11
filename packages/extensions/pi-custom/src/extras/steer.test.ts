import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSteerNow, restoredQueue, STEERING } from "./steer.ts";

describe("restoredQueue", () => {
	it("is everything pi restored when there was no draft", () => {
		expect(restoredQueue("fix the test\n\nthen push", "")).toBe("fix the test\n\nthen push");
	});

	it("is the part in front of the draft", () => {
		expect(restoredQueue("queued one\n\nhalf-typed", "half-typed")).toBe("queued one");
	});

	it("refuses an editor in any other shape", () => {
		expect(restoredQueue("something else", "half-typed")).toBeUndefined();
		expect(restoredQueue("half-typed", "half-typed")).toBeUndefined();
		expect(restoredQueue("   ", "")).toBeUndefined();
	});
});

function harness() {
	const events = new Map<string, (event: any, ctx: ExtensionContext) => void>();
	const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => void }>();
	let input: ((data: string) => unknown) | undefined;
	const state = { editor: "draft", pending: ["queued one", "queued two"], idle: false, aborts: 0, sent: [] as string[] };
	const ctx = {
		hasUI: true,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending.length > 0,
		ui: {
			getEditorText: () => state.editor,
			setEditorText: (text: string) => { state.editor = text; },
			onTerminalInput: (handler: typeof input) => { input = handler; return () => { input = undefined; }; },
		},
		// InteractiveMode's extension abort restores the queue before aborting.
		abort: () => {
			state.aborts++;
			state.editor = [...state.pending, state.editor].filter((text) => text.trim()).join("\n\n");
			state.pending = [];
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (event: any, ctx: ExtensionContext) => void) => events.set(event, handler),
		registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => void }) => shortcuts.set(key, options),
		sendUserMessage: (text: string) => state.sent.push(text),
	} as unknown as ExtensionAPI;
	registerSteerNow(pi);
	const emit = (event: string, data = {}) => events.get(event)?.(data, ctx);
	emit("session_start");
	return { state, emit, input: (data: string) => input?.(data), sendNow: () => {
		expect(shortcuts.has("ctrl+enter")).toBe(true);
		shortcuts.get("ctrl+enter")!.handler(ctx);
	} };
}

describe("Ctrl+Enter steering", () => {
	it("aborts and sends the restored queue once settled, preserving the draft", () => {
		const h = harness();
		h.sendNow();
		expect(h.state.aborts).toBe(1);
		expect(h.state.sent).toEqual([]);
		expect((globalThis as any)[STEERING]).toBe(true);
		// Tool interruption need not produce an assistant message marked aborted.
		h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse" }] });
		h.emit("agent_settled");
		expect(h.state.sent).toEqual(["queued one\n\nqueued two"]);
		expect(h.state.editor).toBe("draft");
		expect((globalThis as any)[STEERING]).toBe(false);
		h.emit("agent_settled");
		expect(h.state.sent).toHaveLength(1);
	});

	it("leaves Escape as abort-only even with queued messages", () => {
		const h = harness();
		expect(h.input("\x1b")).toBeUndefined();
		h.state.editor = "queued one\n\nqueued two\n\ndraft";
		h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
		h.emit("agent_settled");
		expect(h.state.sent).toEqual([]);
		expect(h.state.editor).toContain("queued one");
	});

	it("lets Escape cancel a pending send-now request", () => {
		const h = harness();
		h.sendNow();
		h.input("\x1b[27u");
		h.emit("agent_settled");
		expect(h.state.sent).toEqual([]);
		expect((globalThis as any)[STEERING]).toBe(false);
	});

	it("does nothing when idle or when no messages are queued", () => {
		const h = harness();
		h.state.idle = true;
		h.sendNow();
		h.state.idle = false;
		h.state.pending = [];
		h.sendNow();
		expect(h.state.aborts).toBe(0);
	});

	it("ignores repeated Ctrl+Enter while the abort settles", () => {
		const h = harness();
		h.sendNow();
		h.sendNow();
		h.emit("agent_settled");
		expect(h.state.aborts).toBe(1);
		expect(h.state.sent).toEqual(["queued one\n\nqueued two"]);
	});

	it("does not send an editor changed while the abort settles", () => {
		const h = harness();
		h.sendNow();
		h.state.editor = "new draft";
		h.emit("agent_settled");
		expect(h.state.sent).toEqual([]);
		expect(h.state.editor).toBe("new draft");
	});

	it("does not send new typing when the original draft was empty", () => {
		const h = harness();
		h.state.editor = "";
		h.sendNow();
		h.state.editor += "new typing";
		h.emit("agent_settled");
		expect(h.state.sent).toEqual([]);
		expect(h.state.editor).toContain("new typing");
	});

	it("clears a pending send when the session shuts down", () => {
		const h = harness();
		h.sendNow();
		h.emit("session_shutdown");
		h.emit("agent_settled");
		expect(h.state.sent).toEqual([]);
		expect((globalThis as any)[STEERING]).toBe(false);
	});
});
