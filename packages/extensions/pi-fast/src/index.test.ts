import { describe, expect, it } from "bun:test";
import register from "./index.ts";

function fixture() {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	let entries: any[] = [];
	const statuses = new Map<string, string>();
	const notices: string[] = [];
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" },
		sessionManager: { getBranch: () => entries },
		ui: {
			setStatus: (key: string, value: string | undefined) => {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
			notify: (text: string) => { notices.push(text); },
		},
	};
	register({
		on: (event: string, handler: any) => { handlers.set(event, handler); },
		registerCommand: (name: string, command: any) => { commands.set(name, command); },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
	});
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
	return {
		ctx, statuses, notices, commands, emit,
		get entries() { return entries; },
		set entries(value: any[]) { entries = value; },
		async command(args = "") {
			expect(commands.get("fast")).toBeDefined();
			await commands.get("fast")?.handler(args, ctx);
		},
		request(payload: unknown = { model: ctx.model.id }) { return emit("before_provider_request", { payload }); },
	};
}

describe("pi-fast", () => {
	it("starts off and toggles priority and its status without mutating the original request", async () => {
		const f = fixture();
		f.emit("session_start");
		const payload = { model: f.ctx.model.id, input: [], service_tier: "flex" };
		expect(f.request(payload)).toBeUndefined();
		await f.command();
		expect(f.statuses.get("pi-fast")).toBe("fast");
		expect(f.request(payload)).toEqual({ ...payload, service_tier: "priority" });
		expect(payload.service_tier).toBe("flex");
		expect(f.notices.at(-1)).toContain("cost");
		await f.command();
		expect(f.statuses.has("pi-fast")).toBe(false);
		expect(f.request(payload)).toBeUndefined();
	});

	it("supports explicit on/off/toggle, rejects bad arguments, and only records changes", async () => {
		const f = fixture();
		await f.command("on");
		await f.command("on");
		expect(f.entries).toHaveLength(1);
		await f.command("bogus");
		expect(f.notices.at(-1)).toContain("Usage:");
		expect(f.entries).toHaveLength(1);
		await f.command("off");
		expect(f.request()).toBeUndefined();
		await f.command("toggle");
		expect(f.request()).toMatchObject({ service_tier: "priority" });
		expect(f.entries).toHaveLength(3);
	});

	it("supports only the configured OpenAI model and API pairs", async () => {
		const models = ["gpt-5.4", "gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"];
		for (const [provider, api] of [["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"]]) {
			for (const id of models) {
				const f = fixture();
				f.ctx.model = { provider, api, id };
				await f.command("on");
				expect(f.request()).toEqual({ model: id, service_tier: "priority" });
			}
		}
		for (const change of [
			{ provider: "anthropic" }, { provider: "openrouter" }, { id: "gpt-4.1" },
			{ id: "gpt-5.6-sol-unlisted" }, { api: "openai-completions" },
		]) {
			const f = fixture();
			Object.assign(f.ctx.model, change);
			await f.command("on");
			expect(f.request()).toBeUndefined();
			expect(f.statuses.has("pi-fast")).toBe(false);
			expect(f.notices.at(-1)).toContain("inactive");
		}
	});

	it("does not rewrite malformed or mismatched payloads", async () => {
		const f = fixture();
		await f.command("on");
		for (const payload of [null, [], "text", {}, { model: "different-model" }]) {
			expect(f.request(payload)).toBeUndefined();
		}
	});

	it("hides on unsupported model changes and restores the preference on switching back", async () => {
		const f = fixture();
		await f.command("on");
		f.ctx.model.provider = "anthropic";
		f.emit("model_select");
		expect(f.statuses.has("pi-fast")).toBe(false);
		f.ctx.model.provider = "openai-codex";
		f.emit("model_select");
		expect(f.statuses.get("pi-fast")).toBe("fast");
		f.emit("session_shutdown");
		expect(f.statuses.has("pi-fast")).toBe(false);
	});

	it("restores branch-local state across resume/compaction and resets for a new session", async () => {
		const f = fixture();
		await f.command("on");
		const enabled = [...f.entries];
		await f.command("off");
		f.entries = enabled;
		f.emit("session_tree");
		expect(f.statuses.get("pi-fast")).toBe("fast");
		f.emit("session_compact");
		expect(f.request()).toMatchObject({ service_tier: "priority" });
		f.entries = [];
		f.emit("session_start");
		expect(f.request()).toBeUndefined();
		f.entries = [...enabled,
			{ type: "message", customType: "pi-fast:state", data: { enabled: false } },
			{ type: "custom", customType: "pi-fast:state", data: { enabled: "false" } },
		];
		f.emit("session_start");
		expect(f.request()).toMatchObject({ service_tier: "priority" });
	});
});
