import { STATE_TYPE } from "./state.ts";
import { afterEach, expect, test } from "bun:test";
import register from "./index.ts";
import { MinimapView } from "./view.ts";
const shutdown: Array<() => void> = [];
afterEach(() => {
	shutdown.splice(0).forEach((close) => close());
});
function harness() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const shortcuts = new Map<string, any>();
	let command!: (args: string, ctx: any) => Promise<void>;
	let view: MinimapView | undefined,
		input: ((data: string) => unknown) | undefined;
	let visibility: ((shown: boolean) => void) | undefined;
	let branch: any[] = [
		{
			id: "a",
			type: "message",
			message: { role: "user", content: "Build a minimap" },
		},
	];
	const calls: any[] = [],
		persisted: any[] = [],
		notices: string[] = [];
	const theme = {
		fg: (_slot: string, text: string) => text,
		bg: (_slot: string, text: string) => text,
		bold: (text: string) => text,
	};
	const tui = { requestRender() {}, terminal: { rows: 30 } };
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "fake-session",
			getBranch: () => branch,
			getEntries: () => [
				...branch,
				...persisted.map((data) => ({
					type: "custom",
					customType: "pi-minimap:state",
					data,
				})),
			],
		},
		ui: {
			setSidebar(_key: string, factory: any, options: any) {
				visibility?.(false);
				visibility = options?.onVisibilityChange;
				view = factory?.(tui, theme);
				visibility?.(true);
				return true;
			},
			scrollToSessionEntry: () => true,
			onEditorInput(handler: any) {
				input = handler;
				return () => {
					input = undefined;
				};
			},
			notify(text: string) {
				notices.push(text);
			},
		},
		modelRegistry: {
			getAvailable: () => [
				{
					provider: "cerebras",
					id: "qwen-test",
					cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
				},
				{
					provider: "openai",
					id: "gpt-6-luna",
					cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
				},
			],
			streamSimple(model: any, context: any, options: any) {
				calls.push({ model, context, options });
				return {
					result: async () => ({
						content: [
							{
								type: "text",
								text: JSON.stringify({
									beat: "Started the minimap",
									tone: "neutral",
									now: "Implement a minimap",
								}),
							},
						],
						stopReason: "stop",
						usage: {
							input: 100,
							output: 20,
							cacheRead: 0,
							cacheWrite: 0,
							cost: { total: 0.001 },
						},
					}),
				};
			},
		},
	};
	register({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerShortcut: (key: string, spec: any) => shortcuts.set(key, spec),
		registerCommand: (_name: string, spec: any) => {
			command = spec.handler;
		},
		appendEntry: (customType: string, data: any) => {
			if (customType === STATE_TYPE) persisted.push(data);
			branch.push({
				id: `entry${branch.length}`,
				type: "custom",
				customType,
				data,
			});
		},
	} as any);
	handlers.get("session_start")!({}, ctx);
	shutdown.push(() => handlers.get("session_shutdown")!({}, ctx));
	return {
		ctx,
		shortcuts,
		calls,
		persisted,
		notices,
		view: () => view!,
		command: (args: string) => command(args, ctx),
		input: (key: string) => input?.(key),
		visibility: (shown: boolean) => visibility?.(shown),
		emit: (name: string, event: any = {}) => handlers.get(name)!(event, ctx),
		branch: (entries: any[]) => {
			branch = entries;
		},
	};
}

test("starts visible; runtime adapter uses no tools, limits output and asks Luna for low reasoning", async () => {
	const h = harness();
	expect(h.calls).toHaveLength(0);
	expect(h.view().engine.state.enabled).toBe(true);
	expect(h.input("\r")).toBeUndefined();
	await h.command("on");
	await h.view().engine.refresh();
	expect(h.calls).toHaveLength(1);
	expect(h.calls[0].model.provider).toBe("cerebras");
	expect(h.calls[0].context.tools).toBeUndefined();
	expect(h.calls[0].options.maxTokens).toBe(600);
	expect(h.calls[0].options.reasoning).toBeUndefined();
	h.branch([
		{ id: "a", type: "message", message: { role: "user", content: "Build" } },
		{
			id: "b",
			type: "message",
			message: { role: "assistant", content: "Checking" },
		},
	]);
	await h.command("model");
	await h.view().engine.refresh();
	expect(h.calls[1].model.provider).toBe("openai");
	expect(h.calls[1].options.reasoning).toBe("low");
	expect(h.view().engine.state.usage.requests).toBe(2);
});

test("narrow hiding pauses requests and restores a distinct catch-up", async () => {
	const h = harness();
	await h.command("on");
	await h.view().engine.refresh();
	h.visibility(false);
	h.branch([
		{ id: "a", type: "message", message: { role: "user", content: "Build" } },
		{
			id: "b",
			type: "message",
			message: { role: "assistant", content: "Checking" },
		},
	]);
	h.emit("message_end", { message: { role: "assistant" } });
	await h.view().engine.refresh();
	expect(h.calls).toHaveLength(1);
	h.visibility(true);
	await h.view().engine.refresh();
	expect(h.calls).toHaveLength(2);
	expect(h.view().engine.state.recent.at(-1)?.recap).toBe(true);
});

test("branch switch cancels the old observer and does not carry a sibling's summary, but retains actual session spend", async () => {
	const h = harness();
	await h.command("on");
	await h.view().engine.refresh();
	const old = h.view().engine;
	h.branch([
		{
			id: "other",
			type: "message",
			message: { role: "user", content: "Different task" },
		},
	]);
	h.emit("session_tree");
	expect(old.visible).toBe(false);
	await h.command("on");
	expect(h.view().engine.state.recent).toHaveLength(0);
	expect(h.view().engine.state.usage.requests).toBe(1);
	await h.view().engine.refresh();
	expect(h.view().engine.state.recent[0]?.from).toBe("other");
});

test("runtime status comes from execution events, not model prose", async () => {
	const h = harness();
	await h.command("on");
	h.emit("agent_start");
	h.emit("tool_execution_start", {
		toolCallId: "q",
		toolName: "ask_user_question",
		args: {},
	});
	expect(h.view().render(38).join("\n")).toContain("Waiting for an answer");
	h.emit("tool_execution_end", {
		toolCallId: "q",
		toolName: "ask_user_question",
		isError: false,
	});
	h.emit("tool_execution_start", {
		toolCallId: "w",
		toolName: "goal_wait",
		args: { waiting_for: "background" },
	});
	h.emit("tool_execution_end", {
		toolCallId: "w",
		toolName: "goal_wait",
		isError: false,
	});
	h.emit("agent_end");
	expect(h.view().render(38).join("\n")).toContain(
		"Waiting for background work",
	);
});

test("headless mode does not mount or spend", async () => {
	const h = harness();
	h.ctx.mode = "rpc";
	h.emit("session_start");
	await h.command("on");
	expect(h.calls).toHaveLength(0);
	expect(h.notices.at(-1)).toContain("fullscreen TUI");
});

test("branch replacement waits for cancellation and accounts a late paid reply without restoring its summary", async () => {
	const h = harness();
	const original = h.ctx.modelRegistry.streamSimple;
	let resolve!: (value: any) => void;
	let requests = 0;
	h.ctx.modelRegistry.streamSimple = (...args: any[]) => {
		requests++;
		if (requests === 1)
			return {
				result: () =>
					new Promise((done) => {
						resolve = done;
					}),
			};
		return original(...args);
	};
	await h.command("on");
	const old = h.view().engine.refresh();
	await Promise.resolve(); // Let the metadata lookup finish and inference start.
	h.branch([
		{
			id: "other",
			type: "message",
			message: { role: "user", content: "Different task" },
		},
	]);
	h.emit("session_tree");
	await h.command("on");
	const next = h.view().engine.refresh();
	await Promise.resolve();
	expect(requests).toBe(1);
	resolve({
		content: [{ type: "text", text: "stale reply" }],
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { total: 0.004 },
		},
	});
	await Promise.all([old, next]);
	const { readCalls } = await import("./audit.ts");
	const stale = readCalls(h.ctx.sessionManager.getEntries()).find((call) =>
		call.events.some((event) => event.text === "stale reply"),
	);
	expect(stale?.events.some((event) => event.phase === "discarded")).toBe(true);
	expect(requests).toBe(2);
	expect(h.view().engine.state.recent.map((beat) => beat.from)).toEqual([
		"other",
	]);
	expect(h.view().engine.state.usage).toMatchObject({
		requests: 2,
		input: 200,
		output: 40,
		unknownCost: 0,
	});
	expect(h.persisted.at(-1).usage.cost).toBeCloseTo(0.005);
});

test("unavailable models neither spend nor fall back to a different provider", async () => {
	const h = harness();
	h.ctx.modelRegistry.getAvailable = () => [];
	await h.command("on");
	await h.view().engine.refresh();
	expect(h.calls).toHaveLength(0);
	expect(h.view().engine.state.usage.requests).toBe(0);
	expect(h.view().engine.error).toContain("Model unavailable");
});

test("a fork keeps inherited history but starts a separate spend ledger with a reused session manager", async () => {
	const h = harness();
	await h.command("on");
	await h.view().engine.refresh();
	expect(h.view().engine.state.usage.requests).toBe(1);
	h.ctx.sessionManager.getSessionId = () => "fork-session";
	h.emit("session_start", { reason: "fork" });
	expect(h.view().engine.state.recent).toHaveLength(1);
	expect(h.view().engine.state.usage.requests).toBe(0);
});

test("Cerebras catalogue rates override stored SDK cost without counting metadata as inference", async () => {
	const { spyOn } = await import("bun:test");
	let lookups = 0;
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
		lookups++;
		return Response.json({
			data: [
				{
					id: "cerebras/qwen-test",
					pricing: { prompt: "0.0000006", completion: "0.0000012" },
				},
			],
		});
	});
	try {
		const h = harness();
		const models = h.ctx.modelRegistry.getAvailable();
		h.ctx.modelRegistry.getAvailable = () => [
			{ ...models[0], baseUrl: "https://api.cerebras.ai/v1" },
		];
		h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
			ok: true,
			apiKey: "fixture-key",
		});
		await h.command("on");
		await h.view().engine.refresh();
		expect(h.view().engine.state.usage.cost).toBeCloseTo(0.000084, 10);
		expect(h.view().engine.state.usage.requests).toBe(1);
		expect(lookups).toBe(1);
		h.branch([
			{
				id: "next",
				type: "message",
				message: { role: "user", content: "Continue" },
			},
		]);
		await h.view().engine.refresh();
		expect(lookups).toBe(1);
		expect(h.view().engine.state.usage.requests).toBe(2);
	} finally {
		fetchSpy.mockRestore();
	}
});

test("minute ticks refresh ages locally and hiding clears the timer", async () => {
	const { spyOn } = await import("bun:test");
	const original = globalThis.setInterval;
	let tick: (() => void) | undefined,
		timer: ReturnType<typeof setInterval> | undefined;
	const intervals = spyOn(globalThis, "setInterval").mockImplementation(((
		fn: () => void,
		ms: number,
	) => {
		expect(ms).toBe(60000);
		tick = fn;
		timer = original(fn, ms);
		return timer;
	}) as typeof setInterval);
	const clear = spyOn(globalThis, "clearInterval");
	try {
		const h = harness();
		await h.command("on");
		await h.view().engine.refresh();
		expect(h.calls).toHaveLength(1);
		tick!();
		expect(h.calls).toHaveLength(1);
		h.visibility(false);
		expect(clear).toHaveBeenCalledWith(timer);
	} finally {
		intervals.mockRestore();
		clear.mockRestore();
	}
});

test("minimap shortcuts are discoverable and do not claim Intercom's Alt+j", async () => {
	const h = harness();
	expect(h.shortcuts.get("alt+m").description).toBe("Toggle minimap");
	expect(h.shortcuts.has("alt+shift+m")).toBe(true);
	expect(h.shortcuts.has("alt+j")).toBe(false);
	await h.shortcuts.get("alt+m").handler(h.ctx);
	expect(h.persisted.at(-1).enabled).toBe(false);
});

test("call journal retains full inputs, excludes reasoning, and records rejected replies", async () => {
	const { readCalls } = await import("./audit.ts");
	const h = harness();
	h.ctx.modelRegistry.streamSimple = () => ({
		result: async () => ({
			content: [
				{ type: "thinking", thinking: "PRIVATE_REASONING" },
				{ type: "text", text: "malformed visible response" },
			],
			stopReason: "stop",
			usage: {
				input: 20,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.001 },
			},
		}),
	});
	await h.command("on");
	await h.view().engine.refresh();
	const calls = readCalls(h.ctx.sessionManager.getEntries());
	expect(calls).toHaveLength(1);
	expect(calls[0]!.events.map((e) => e.phase)).toEqual([
		"request",
		"started",
		"response",
		"accounting",
		"invalid",
	]);
	expect(calls[0]!.events[0]!.prompt).toContain("Build a minimap");
	expect(calls[0]!.events[0]!.parameters).toMatchObject({
		maxTokens: 600,
		sessionId: "pi-minimap:fake-session:qwen",
	});
	expect(JSON.stringify(calls)).toContain("malformed visible response");
	expect(JSON.stringify(calls)).not.toContain("PRIVATE_REASONING");
});
