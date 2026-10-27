import { expect, test } from "bun:test";
import { deterministicHardDeny } from "./hard-deny.ts";
import {
	classifyInStages,
	buildClassifierActionMessage,
} from "./classifier.ts";

test("system-wide deletion protection includes macOS user roots and find traversal options", () => {
	for (const command of [
		"rm -rf /Users",
		"rm -rf /Users/another-user",
		"find -H /etc -delete",
		"find -L /etc -delete",
		"find -H -L /etc -delete",
		"find -P /Users -delete",
	]) {
		expect(deterministicHardDeny("bash", { command }, process.cwd())).toMatch(
			command.startsWith("find")
				? /system-wide delete/
				: /irreversible deletion/,
		);
	}
	expect(
		deterministicHardDeny(
			"bash",
			{ command: "find -H /tmp/automode-find-subtree -delete" },
			process.cwd(),
		),
	).toBeUndefined();
});

test("Codex classifier attempts do not retain sockets under a separate session ID", async () => {
	const calls: any[] = [];
	const responses = [
		{ type: "text", text: "1" },
		{
			type: "toolCall",
			id: "decision",
			name: "classifier_decision",
			arguments: { decision: "allow", tier: "allow", reason: "read-only" },
		},
	];
	const complete: any = async (_model: any, _prompt: any, options: any) => {
		calls.push(options);
		return {
			role: "assistant",
			content: [responses.shift()],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "test",
			stopReason: calls.length === 1 ? "stop" : "toolUse",
			timestamp: Date.now(),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	};
	const model: any = {
		provider: "openai-codex",
		id: "test",
		api: "openai-codex-responses",
		contextWindow: 200000,
		maxTokens: 32000,
	};
	const result = await classifyInStages(
		complete,
		{ model },
		{
			systemPrompt: "policy",
			contextMessage: {
				role: "user",
				content: [{ type: "text", text: "context" }],
				timestamp: 1,
			},
			actionMessage: buildClassifierActionMessage("exact action"),
		},
		undefined,
		{ sessionId: "pi-automode:test" },
	);
	expect(result.decision).toBe("allow");
	expect(calls.map((call) => call.cacheRetention)).toEqual(["none", "none"]);
});
