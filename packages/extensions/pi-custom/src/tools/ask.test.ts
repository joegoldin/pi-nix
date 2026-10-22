import { expect, test } from "bun:test";
import { registerAsk } from "./ask.ts";

const questions = [{
	question: "May I edit the overlay without pushing?", header: "Scope",
	options: [{ label: "Approve", description: "Edit and format only." }, { label: "No", description: "Do not edit." }],
}];

function harness(pick: boolean) {
	let tool: { execute: Function };
	const entries: { type: string; data: unknown }[] = [];
	const events: string[] = [];
	registerAsk({
		on() {},
		registerTool: (value: typeof tool) => { tool = value; },
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		events: { emit: (name: string) => events.push(name) },
	} as never);
	const ctx = { hasUI: true, mode: "rpc", ui: { select: async (_title: string, options: string[]) => pick ? options[0] : undefined } };
	return { run: () => tool.execute("q1", { questions }, undefined, undefined, ctx), entries, events };
}

test("a submitted questionnaire records its scope and notifies the permission owner", async () => {
	const h = harness(true);
	await h.run();
	expect(h.entries).toEqual([{ type: "pi-user-decision", data: expect.objectContaining({ version: 1, source: "questionnaire", toolCallId: "q1", questions, cancelled: false }) }]);
	expect(h.events).toEqual(["pi-user-decision:submitted"]);
});

test("a cancelled questionnaire produces neither authority nor a submission event", async () => {
	const h = harness(false);
	await h.run();
	expect(h.entries).toEqual([]);
	expect(h.events).toEqual([]);
});

function cancellable() {
	let tool: { execute: Function };
	const entries: unknown[] = []; const events: unknown[] = [];
	registerAsk({ on() {}, registerTool: (value: typeof tool) => { tool = value; }, appendEntry: (...args: unknown[]) => entries.push(args), events: { emit: (...args: unknown[]) => events.push(args) } } as never);
	const controller = new AbortController();
	return { controller, entries, events, run: (ui: unknown, mode = "tui") => tool.execute("cancel", { questions }, controller.signal, undefined, { hasUI: true, mode, ui }) };
}
const settled = (pending: Promise<any>) => Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("timed out"), 50))]);

test("aborting an open questionnaire settles without creating user authority", async () => {
	const h = cancellable(); let closed = false;
	const pending = h.run({ custom: (factory: Function) => new Promise<void>((resolve) => {
		factory({ requestRender() {} }, {}, {}, () => { closed = true; resolve(); });
	}) });
	h.controller.abort();
	const result = await settled(pending);
	expect(result).not.toBe("timed out");
	expect(result.details.cancelled).toBe(true);
	expect(closed).toBe(true);
	expect(h.entries).toEqual([]); expect(h.events).toEqual([]);
});

test("aborting before a queued UI opens settles immediately and skips its stale questionnaire", async () => {
	const h = cancellable(); let open: () => void = () => {}; let closed = false;
	const pending = h.run({ custom: (factory: Function) => new Promise<void>((resolve) => {
		open = () => { factory({ requestRender() {} }, {}, {}, () => { closed = true; resolve(); }); };
	}) });
	h.controller.abort();
	const result = await settled(pending);
	expect(result).not.toBe("timed out");
	expect(result.details.cancelled).toBe(true);
	open(); expect(closed).toBe(true);
	expect(h.entries).toEqual([]);
});

test("an already-aborted call opens no UI", async () => {
	const h = cancellable(); h.controller.abort();
	let calls = 0;
	const result = await h.run({ custom: async () => { calls++; } });
	expect(calls).toBe(0); expect(result.details.cancelled).toBe(true);
});

test("RPC questions forward cancellation to their native dialog", async () => {
	const h = cancellable(); let signal: AbortSignal | undefined;
	const pending = h.run({ select: (_title: string, _options: string[], opts?: { signal: AbortSignal }) => new Promise((resolve) => {
		signal = opts?.signal; signal?.addEventListener("abort", () => resolve(undefined), { once: true });
	}) }, "rpc");
	h.controller.abort();
	expect(signal).toBe(h.controller.signal);
	expect(await settled(pending)).not.toBe("timed out");
	expect(h.entries).toEqual([]);
});
