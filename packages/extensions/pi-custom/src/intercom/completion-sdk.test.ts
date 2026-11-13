import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerIntercomTool } from "./tool.ts";

test("the native SDK saves the completion result and final reply before requesting graceful shutdown", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-peer-completion-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const manager = SessionManager.create(directory, directory);
	const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false } });
	const reports: any[] = [];
	let exits = 0, prompts = 0, requests = 0;
	const model = {
		id: "completion-fixture", name: "Fixture", api: "anthropic-messages", provider: "peer-completion-fixture",
		baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000,
	};
	const streamSimple = () => {
		const first = requests++ === 0;
		const message = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
			content: first
				? [{ type: "toolCall", id: "completion-call", name: "intercom", arguments: { action: "complete", to: "requester", message: "Reviewed the assigned diff; all checks passed.", requestCleanup: true, quit: "ask" } }]
				: [{ type: "text", text: "FINAL_PEER_REPLY" }],
			stopReason: first ? "toolUse" : "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message } as never));
		return stream;
	};
	const loader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, disabledBuiltinExtensions: ["mcp"],
		extensionFactories: [(api) => {
			api.registerProvider("peer-completion-fixture", { api: "anthropic-messages", baseUrl: model.baseUrl, apiKey: "synthetic-local-fixture-key", models: [model as never], streamSimple: streamSimple as never });
			registerIntercomTool(api, () => ({
			send: async (_ctx: unknown, request: unknown) => {
				reports.push(request);
				return { content: [{ type: "text", text: "Report delivered" }], details: { delivered: true, delivery: "socket_delivered", messageId: "completion-1" } };
			},
			exitBlockers: () => [],
		}) as never);
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({ cwd: directory, agentDir: directory, model: model as never, thinkingLevel: "off", sessionManager: manager, settingsManager, resourceLoader: loader, tools: ["intercom"] }));

		await session.bindExtensions({
			mode: "tui",
			uiContext: { confirm: async () => { prompts++; return true; }, notify() {}, setProgramStatus() {} } as never,
			shutdownHandler: () => {
				exits++;
				const saved = SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages;
				expect(saved.some((m: any) => m.role === "toolResult" && m.toolName === "intercom" && m.details?.exit === "scheduled")).toBe(true);
				expect(JSON.stringify(saved)).toContain("FINAL_PEER_REPLY");
			},
		});
		await session.prompt("Finish the review, report back and ask me whether to exit.");
		expect(requests).toBe(2);
		expect(reports).toHaveLength(1);
		expect(prompts).toBe(1);
		expect(exits).toBe(1);
	} finally {
		if (session) {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(directory, { recursive: true, force: true });
	}
});
