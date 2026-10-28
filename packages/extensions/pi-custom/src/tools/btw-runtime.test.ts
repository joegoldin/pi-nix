import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createSideRuntime,
	disposeSideRuntime,
	SIDE_READ_TOOLS,
} from "./btw-runtime.ts";

test("the actual SDK side runtime exposes only read tools and rejects hidden write calls", async () => {
	const directory = mkdtempSync(join(tmpdir(), "btw-runtime-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	let session: Awaited<ReturnType<typeof createSideRuntime>> | undefined;
	try {
		const manager = SessionManager.create(directory, directory);
		const ctx = {
			cwd: directory,
			sessionManager: manager,
			model: {
				id: "fixture",
				name: "Fixture",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "http://127.0.0.1:1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 1000,
			},
		};
		session = await createSideRuntime(
			{ getSettings: () => ({}), getThinkingLevel: () => "off" } as never,
			ctx as never,
			manager,
			"read-only",
			{ notify() {} } as never,
		);
		expect(session.getActiveToolNames().sort()).toEqual(
			[...SIDE_READ_TOOLS].sort(),
		);
		const result = await session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolName: "write",
			toolCallId: "hidden-write",
			input: { path: join(directory, "never-written"), content: "not allowed" },
		} as never);
		expect(result).toMatchObject({ block: true });
		expect(result?.reason).toContain("read-only");
	} finally {
		if (session) await disposeSideRuntime(session);
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("editing loads real child permission prompts and preserves parent ownership", async () => {
	const entry = process.env.PI_PERMISSIONS_ENTRY;
	if (!entry)
		throw new Error(
			"PI_PERMISSIONS_ENTRY is required for the packaged child-permission integration test",
		);
	const directory = mkdtempSync(join(tmpdir(), "btw-permissions-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const key = Symbol.for("pi-subagents.required-child-extensions.v1");
	const root = globalThis as unknown as Record<symbol, unknown>;
	const previous = root[key];
	process.env.PI_CODING_AGENT_DIR = directory;
	const parent = SessionManager.create(directory, directory);
	const child = SessionManager.create(directory, directory);
	const parentRules = [
		{ id: "pi-permissions", path: entry, requireForAllRunners: true },
	];
	const registry = {
		version: 1,
		bySession: new Map([[parent.getSessionId(), parentRules]]),
	};
	root[key] = registry;
	let session: Awaited<ReturnType<typeof createSideRuntime>> | undefined;
	try {
		let prompts = 0;
		const ctx = {
			cwd: directory,
			sessionManager: parent,
			model: {
				id: "fixture",
				name: "Fixture",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "http://127.0.0.1:1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 1000,
			},
		};
		session = await createSideRuntime(
			{ getSettings: () => ({}), getThinkingLevel: () => "off" } as never,
			ctx as never,
			child,
			"edit",
			{
				notify() {},
				setStatus() {},
				setWidget() {},
				custom: async () => {
					prompts++;
					return undefined;
				},
			} as never,
		);
		expect(session.getActiveToolNames()).toContain("write");
		expect(registry.bySession.has(child.getSessionId())).toBe(true);
		const args = {
			path: "/etc/btw-never-written",
			content: "must not execute",
		};
		const result = await session.agent.beforeToolCall!({
			toolCall: {
				type: "toolCall",
				id: "protected-write",
				name: "write",
				arguments: args,
			},
			args,
		} as never);
		expect(result).toMatchObject({ block: true });
		expect(prompts).toBeGreaterThan(0);
		expect(JSON.stringify(result)).not.toContain("gate failed");
		await disposeSideRuntime(session);
		session = undefined;
		expect(registry.bySession.has(child.getSessionId())).toBe(false);
		expect(registry.bySession.get(parent.getSessionId())).toBe(parentRules);
	} finally {
		if (session) await disposeSideRuntime(session);
		if (previous === undefined) delete root[key];
		else root[key] = previous;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("native SDK streams a turn, executes a read tool, and persists the independent conversation", async () => {
	const { writeFileSync, readFileSync } = await import("node:fs");
	const directory = mkdtempSync(join(tmpdir(), "btw-stream-"));
	const oldDir = process.env.PI_CODING_AGENT_DIR;
	const oldKey = process.env.ANTHROPIC_API_KEY;
	process.env.PI_CODING_AGENT_DIR = directory;
	process.env.ANTHROPIC_API_KEY = "synthetic-local-fixture-key";
	const source = join(directory, "fixture.txt");
	writeFileSync(source, "LOCAL_TOOL_RESULT");
	const requests: any[] = [];
	const sse = (event: string, data: unknown) =>
		`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push(await request.json());
			const tool = requests.length === 1;
			const pieces = [
				sse("message_start", {
					type: "message_start",
					message: {
						id: "fixture-message",
						type: "message",
						role: "assistant",
						model: "fixture",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 4, output_tokens: 0 },
					},
				}),
				sse("content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: tool
						? { type: "tool_use", id: "read-fixture", name: "read", input: {} }
						: { type: "text", text: "" },
				}),
				sse("content_block_delta", {
					type: "content_block_delta",
					index: 0,
					delta: tool
						? {
								type: "input_json_delta",
								partial_json: JSON.stringify({ path: source }),
							}
						: { type: "text_delta", text: "ANSWER_ALPHA " },
				}),
				...(tool
					? []
					: [
							sse("content_block_delta", {
								type: "content_block_delta",
								index: 0,
								delta: { type: "text_delta", text: "ANSWER_OMEGA" },
							}),
						]),
				sse("content_block_stop", { type: "content_block_stop", index: 0 }),
				sse("message_delta", {
					type: "message_delta",
					delta: {
						stop_reason: tool ? "tool_use" : "end_turn",
						stop_sequence: null,
					},
					usage: { output_tokens: 4 },
				}),
				sse("message_stop", { type: "message_stop" }),
			];
			return new Response(
				new ReadableStream({
					start(controller) {
						for (const piece of pieces)
							controller.enqueue(new TextEncoder().encode(piece));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	let session: Awaited<ReturnType<typeof createSideRuntime>> | undefined;
	try {
		const parent = SessionManager.create(directory, directory);
		parent.appendMessage({ role: "user", content: "MAIN_ONLY", timestamp: 1 });
		const before = readFileSync(parent.getSessionFile()!, "utf8");
		const child = SessionManager.create(directory, directory);
		const baseUrl = `http://127.0.0.1:${server.port}`;
		const ctx = {
			cwd: directory,
			sessionManager: parent,
			model: {
				id: "fixture",
				name: "Fixture",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 1000,
			},
		};
		session = await createSideRuntime(
			{
				getSettings: () => ({ retry: { enabled: false } }),
				getThinkingLevel: () => "off",
			} as never,
			ctx as never,
			child,
			"read-only",
			{ notify() {} } as never,
		);
		expect(session.model?.baseUrl).toBe(baseUrl);
		const deltas: string[] = [];
		session.subscribe((event) => {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			)
				deltas.push(event.assistantMessageEvent.delta);
		});
		await session.prompt("PRIVATE_SIDE_QUESTION");
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1])).toContain("LOCAL_TOOL_RESULT");
		expect(deltas).toEqual(["ANSWER_ALPHA ", "ANSWER_OMEGA"]);
		const restored = SessionManager.open(child.getSessionFile()!);
		expect(JSON.stringify(restored.buildSessionContext().messages)).toContain(
			"ANSWER_OMEGA",
		);
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(before);
	} finally {
		if (session) await disposeSideRuntime(session);
		server.stop(true);
		if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldDir;
		if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = oldKey;
		rmSync(directory, { recursive: true, force: true });
	}
}, 10000);
