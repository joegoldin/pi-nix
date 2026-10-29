import { expect, test } from "bun:test";
import { proposeDirectoryAccess } from "./auto/classifier.ts";
import type { EffectiveConfig } from "./auto/types.ts";

const config = { classifierTimeoutMs: 100, maxUserTranscriptTokens: 1000, log: { enabled: false, classifierIo: false } } as EffectiveConfig;
const candidates = [{ path: "/work/repo", access: "write", folders: ["/work/repo", "/work/repo/research"] }];
function context(complete: (...args: any[]) => Promise<any>, signal?: AbortSignal) {
	return {
		cwd: "/launch", signal,
		model: { id: "scope-model", provider: "test", api: "openai-completions", reasoning: false },
		modelRegistry: { complete, getApiKeyAndHeaders: async () => ({ ok: true }) },
		sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Implement this feature in the repository", timestamp: 1 } }] },
	} as never;
}

test("scope suggestions use one registry call with native choices and cannot pick their own lifetime", async () => {
	let calls = 0;
	const proposal = { directories: [{ candidate: 0, folder: 1, access: "write-execute" }] };
	const ctx = context(async (_model, prompt, options) => {
		calls++;
		expect(prompt.systemPrompt).toContain("never invent paths or choose persistence");
		expect(prompt.messages[0].content[0].text).toContain("/work/repo/research");
		expect(options.signal).toBeInstanceOf(AbortSignal);
		return { stopReason: "toolUse", content: [{ type: "toolCall", name: "propose_directory_access", arguments: proposal }] };
	});
	expect(await proposeDirectoryAccess(ctx, config, "write source", "Project context", candidates)).toEqual(proposal);
	expect(calls).toBe(1);
});

test("unavailable, cancelled and timed-out suggestions return no model proposal", async () => {
	let calls = 0;
	const controller = new AbortController(); controller.abort();
	expect(await proposeDirectoryAccess(context(async () => { calls++; }, controller.signal), config, "write", "", candidates)).toBeUndefined();
	expect(calls).toBe(0);
	let requestSignal: AbortSignal | undefined;
	expect(await proposeDirectoryAccess(context(async (_model, _prompt, options) => {
		requestSignal = options.signal;
		return new Promise(() => {});
	}), { ...config, classifierTimeoutMs: 5 } as never, "write", "", candidates)).toBeUndefined();
	expect(requestSignal?.aborted).toBe(true);
	expect(await proposeDirectoryAccess(context(async () => { throw new Error("Unavailable provider"); }), config, "write", "", candidates)).toBeUndefined();
});
