import { describe, expect, it } from "bun:test";
import { queryOpenAIUsage, registerUsage, USAGE_REPORT_CHANNEL } from "./usage.ts";

const token = (account = "test-account") => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const payload = { rate_limit: {
	primary_window: { used_percent: 12, limit_window_seconds: 30 * 86400, reset_at: 1800000000 },
	secondary_window: { used_percent: 2, limit_window_seconds: 18000, reset_at: 1799990000 },
} };

function harness(provider = "openai-codex") {
	const native = provider === "openai-codex" ? token() : "native-token";
	const credentials = { type: "oauth", access: native, clientId: "test-client", scopes: ["chatgpt.tokens.use.direct"] };
	const calls: { url: string; init: RequestInit }[] = [];
	const auth = { source: "OAuth", auth: { apiKey: native } };
	const ctx = {
		mode: "tui", model: { provider, id: "test-model", api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses", baseUrl: provider === "openai-codex" ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1" },
		modelRegistry: {
			isUsingOAuth: () => true,
			getProvider: () => ({ baseUrl: "https://chatgpt.com/backend-api" }),
			getProviderAuth: async (id: string) => id === provider ? auth : { source: "OAuth", auth: { apiKey: token() } },
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: native }),
		},
		sessionManager: { getSessionId: () => "session" },
		ui: { notify() {} },
	};
	const options = {
		signal: new AbortController().signal,
		readCredential: () => credentials,
		fetch: async (url: string | URL | Request, init: RequestInit = {}) => {
			calls.push({ url: String(url), init });
			return Response.json(String(url).endsWith("/chatpass/apps") ? { items: [{ id: "test-client" }], has_more: false } : payload);
		},
	};
	return { ctx, options, calls, auth, credentials };
}

describe("read-only OpenAI usage", () => {
	it("reads Codex account windows without forwarding unrelated headers or making inference requests", async () => {
		const h = harness();
		const report = await queryOpenAIUsage(h.ctx as never, h.options);
		expect(report.providerId).toBe("openai-codex");
		expect(report.buckets[0]).toMatchObject({ used: 12, windowMinutes: 43200, resetsAt: 1800000000 });
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]!.url).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(h.calls[0]!.init.method).toBe("GET");
		expect(h.calls[0]!.init.redirect).toBe("error");
		expect(h.calls[0]!.init.headers).toEqual({ Authorization: `Bearer ${token()}`, "ChatGPT-Account-Id": "test-account", Accept: "application/json" });
		expect(JSON.stringify(report)).not.toContain(token());
	});

	it("uses only the Codex companion token after matching the native app registration", async () => {
		const h = harness("openai");
		const report = await queryOpenAIUsage(h.ctx as never, h.options);
		expect(report.providerId).toBe("openai");
		expect(h.calls.map((c) => c.url)).toEqual([
			"https://chatgpt.com/backend-api/wham/usage/chatpass/apps",
			"https://chatgpt.com/backend-api/wham/usage",
		]);
		expect(JSON.stringify(h.calls)).not.toContain("native-token");
	});

	it("rejects API-key auth, overridden model auth, custom origins and mismatched stored native credentials", async () => {
		for (const alter of [
			(h: ReturnType<typeof harness>) => { h.auth.source = "API key"; },
			(h: ReturnType<typeof harness>) => { h.ctx.model.baseUrl = "https://proxy.example/v1"; },
			(h: ReturnType<typeof harness>) => { h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "override" }); },
		]) {
			const h = harness(); alter(h);
			await expect(queryOpenAIUsage(h.ctx as never, h.options)).rejects.toThrow();
			expect(h.calls).toHaveLength(0);
		}
		const h = harness("openai"); h.credentials.access = "other-account";
		await expect(queryOpenAIUsage(h.ctx as never, h.options)).rejects.toThrow();
		expect(h.calls).toHaveLength(0);
	});

	it("does not silently use an unpaired companion or a partial/ambiguous registration list", async () => {
		for (const list of [
			{ items: [{ id: "other-client" }] },
			{ items: [{ id: "test-client" }], has_more: true },
			{ items: [{ id: "test-client" }, { id: "test-client" }] },
		]) {
			const h = harness("openai");
			h.options.fetch = async () => Response.json(list);
			await expect(queryOpenAIUsage(h.ctx as never, h.options)).rejects.toThrow("registration");
		}
	});

	it("does not publish after credentials change during a request", async () => {
		const h = harness();
		h.options.fetch = async () => { h.auth.source = "API key"; return Response.json(payload); };
		await expect(queryOpenAIUsage(h.ctx as never, h.options)).rejects.toThrow();
	});

	it("handles zero usage and never makes up a monthly bucket from a weekly one", async () => {
		const h = harness();
		h.options.fetch = async () => Response.json({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800 } } });
		const report = await queryOpenAIUsage(h.ctx as never, h.options);
		expect(report.buckets).toHaveLength(1);
		expect(report.buckets[0]).toMatchObject({ used: 0, windowMinutes: 10080 });
	});

	it("fails safely on errors, malformed data, redirects and oversized bodies without exposing their content", async () => {
		for (const response of [
			new Response("secret response body", { status: 401 }),
			new Response("", { status: 302, headers: { Location: "https://other.example" } }),
			Response.json({ rate_limit: { primary_window: { used_percent: "bad", limit_window_seconds: 2592000 } } }),
			new Response("x".repeat(65537)),
		]) {
			const h = harness(); h.options.fetch = async () => response;
			try { await queryOpenAIUsage(h.ctx as never, h.options); throw new Error("unexpected success"); }
			catch (error) { expect(String(error)).not.toContain("secret response body"); expect(String(error)).not.toContain("unexpected success"); }
		}
	});

	it("makes no request after cancellation", async () => {
		const h = harness(); const controller = new AbortController(); controller.abort();
		h.options.signal = controller.signal;
		await expect(queryOpenAIUsage(h.ctx as never, h.options)).rejects.toThrow();
		expect(h.calls).toHaveLength(0);
	});
});

it("registers only reporting lifecycle hooks and a read-only usage command", () => {
	const events: string[] = []; const commands: string[] = [];
	registerUsage({ on: (name: string) => events.push(name), registerCommand: (name: string) => commands.push(name), events: { emit() {} } } as never);
	expect(commands).toEqual(["usage"]);
	expect(events).not.toContain("before_provider_request");
	expect(events).toContain("session_shutdown");
	expect(USAGE_REPORT_CHANNEL).toBe("pi-custom:usage-report");
});

function lifecycle() {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const emitted: any[] = []; const notices: string[] = [];
	const timers = new Set<() => void>();
	const requests: { resolve: (report: any) => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];
	const h = harness(); h.ctx.ui.notify = (text: string) => { notices.push(text); };
	registerUsage({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, command: any) => commands.set(name, command), events: { emit: (_name: string, data: any) => emitted.push(data) } } as never, {
		query: (_ctx: unknown, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => requests.push({ resolve, reject, signal })),
		schedule: (fn: () => void, ms: number) => { expect(ms).toBe(300_000); timers.add(fn); return () => { timers.delete(fn); }; },
	});
	return { ...h, handlers, commands, emitted, notices, timers, requests };
}
const fixtureReport = { providerId: "openai-codex", source: "pi-custom-codex", buckets: [{ windowMinutes: 43200, used: 12 }], semantics: { kind: "consumer-subscription" } };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

it("polls without blocking startup and cancels stale results on model change and shutdown", async () => {
	const h = lifecycle();
	expect(h.handlers.get("session_start")!({}, h.ctx)).toBeUndefined();
	expect(h.requests).toHaveLength(1);
	h.handlers.get("model_select")!({}, h.ctx);
	expect(h.requests[0]!.signal.aborted).toBe(true);
	h.requests[0]!.resolve(fixtureReport); await flush();
	expect(h.emitted.every((e) => !e.report)).toBe(true);
	h.requests[1]!.resolve(fixtureReport); await flush();
	expect(h.emitted.at(-1).report).toEqual(fixtureReport);
	expect(h.timers.size).toBe(1);
	h.handlers.get("session_shutdown")!();
	expect(h.timers.size).toBe(0);
	expect(h.emitted.at(-1).report).toBeUndefined();
});

it("usage command waits for current data and failures clear stale percentages without leaking errors", async () => {
	const h = lifecycle();
	const command = h.commands.get("usage").handler("", h.ctx);
	expect(h.notices).toHaveLength(0);
	h.requests[0]!.resolve(fixtureReport); await command;
	expect(h.notices[0]).toContain("12%");
	const retry = h.commands.get("usage").handler("", h.ctx);
	h.requests[1]!.reject(new Error("secret credential")); await retry;
	expect(h.emitted.at(-1).report).toBeUndefined();
	expect(h.notices.at(-1)).toContain("unavailable");
	expect(h.notices.at(-1)).not.toContain("secret credential");
	h.handlers.get("session_shutdown")!();
});

it("does not poll headless sessions or unsupported providers", () => {
	const h = lifecycle();
	for (const ctx of [{ ...h.ctx, mode: "rpc" }, { ...h.ctx, model: { provider: "anthropic" } }]) h.handlers.get("session_start")!({}, ctx);
	expect(h.requests).toHaveLength(0);
	expect(h.timers.size).toBe(0);
});

it("names the companion login to repair without exposing authentication errors", async () => {
	const h = harness("openai");
	const original = h.ctx.modelRegistry.getProviderAuth;
	h.ctx.modelRegistry.getProviderAuth = async (provider) => {
		if (provider === "openai-codex") throw new Error("401 expired secret-token");
		return original(provider);
	};
	await expect(queryOpenAIUsage(h.ctx as never, h.options)).rejects.toThrow("/login openai-codex");
	expect(h.calls).toHaveLength(0);
});

it("polls again after five minutes and shutdown aborts an in-flight refresh", async () => {
	const h = lifecycle(); h.handlers.get("session_start")!({}, h.ctx);
	h.requests[0]!.resolve(fixtureReport); await flush();
	const timer = [...h.timers][0]!; h.timers.delete(timer); timer();
	expect(h.requests).toHaveLength(2);
	h.handlers.get("session_shutdown")!();
	expect(h.requests[1]!.signal.aborted).toBe(true);
	h.requests[1]!.resolve(fixtureReport); await flush();
	expect(h.emitted.at(-1).report).toBeUndefined();
	expect(h.timers.size).toBe(0);
});

it("rejects ambiguous registration envelopes and contradictory quota data", async () => {
	for (const apps of [{ items: [{ id: "test-client" }, null] }, { items: [{ id: "test-client" }], total: 200 }]) {
		const h = harness("openai"); h.options.fetch = async () => Response.json(apps);
		await expect(queryOpenAIUsage(h.ctx as never, h.options)).rejects.toThrow("registration");
	}
	const h = harness(); h.options.fetch = async () => Response.json({ rate_limit: { primary_window: { used_percent: 10, remaining_percent: 10, limit_window_seconds: 18000 } } });
	await expect(queryOpenAIUsage(h.ctx as never, h.options)).rejects.toThrow("quota");
});
