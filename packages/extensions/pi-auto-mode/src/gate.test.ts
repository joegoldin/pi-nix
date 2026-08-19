import { describe, expect, it, mock } from "bun:test";
import { DEFAULT_CONFIG } from "./config.ts";
import { decide, decideDeterministic } from "./gate.ts";
import type { ToolRequest } from "./request.ts";

const request: ToolRequest = {
	toolName: "bash",
	toolCallId: "c1",
	surface: "bash",
	value: "rm -rf /",
	input: { command: "rm -rf /" },
};

const allowVerdict = { decision: "allow", rule_kind: "none", reason: "" } as const;

function deps(over: Partial<Parameters<typeof decide>[0]> = {}) {
	return {
		config: { ...DEFAULT_CONFIG, enabled: true },
		classify: mock(async () => allowVerdict),
		userTurns: () => [],
		onPrompt: mock(() => {}),
		...over,
	} as Parameters<typeof decide>[0];
}

const tui = { hasUI: true, ui: { confirm: mock(async () => true) } };
const headless = { hasUI: false, ui: { confirm: mock(async () => true) } };

describe("decide", () => {
	it("returns undefined immediately when auto mode is disabled", async () => {
		const d = deps({ config: { ...DEFAULT_CONFIG, enabled: false } });
		expect(await decide(d, headless, request)).toBeUndefined();
		expect(d.classify).not.toHaveBeenCalled();
	});

	it("allows without a model call when a deterministic allow rule matches", async () => {
		const d = deps({
			config: { ...DEFAULT_CONFIG, enabled: true, deterministic: { allow: ["Bash(rm:*)"], deny: [] } },
		});
		expect(await decide(d, headless, { ...request, value: "rm build/x" })).toBeUndefined();
		expect(d.classify).not.toHaveBeenCalled();
	});

	it("blocks without a model call when a deterministic deny rule matches", async () => {
		const d = deps({
			config: { ...DEFAULT_CONFIG, enabled: true, deterministic: { allow: [], deny: ["Bash(rm:*)"] } },
		});
		const result = await decide(d, headless, request);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Bash(rm:*)");
		expect(d.classify).not.toHaveBeenCalled();
	});

	it("consults the classifier when nothing matches, passing recent user turns", async () => {
		const d = deps({ userTurns: () => ["wipe the build dir"] });
		await decide(d, headless, request);
		expect(d.classify).toHaveBeenCalledWith(request, ["wipe the build dir"]);
	});

	it("proceeds on an allow verdict", async () => {
		expect(await decide(deps(), headless, request)).toBeUndefined();
	});

	it("blocks on a deny verdict and surfaces the reason to the model", async () => {
		const d = deps({
			classify: mock(async () => ({ decision: "deny", rule_kind: "soft_deny", reason: "not asked for" }) as const),
		});
		expect(await decide(d, headless, request)).toEqual({ block: true, reason: "not asked for" });
	});

	it("blocks a hard_deny even when the classifier says allow", async () => {
		const d = deps({
			classify: mock(async () => ({ decision: "allow", rule_kind: "hard_deny", reason: "user insisted" }) as const),
		});
		const result = await decide(d, headless, request);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/hard_deny/);
	});

	it("blocks a hard_deny with a UI too, rather than degrading to a prompt the user could wave through", async () => {
		const confirm = mock(async () => true);
		const d = deps({
			classify: mock(async () => ({ decision: "allow", rule_kind: "hard_deny", reason: "ssh key" }) as const),
		});
		const result = await decide(d, { hasUI: true, ui: { confirm } }, request);
		expect(result?.block).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("fails closed by blocking when the classifier throws and there is no UI", async () => {
		const d = deps({
			classify: mock(async () => {
				throw new Error("429 rate limited");
			}),
		});
		const result = await decide(d, headless, request);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/429 rate limited/);
	});

	it("fails closed to a prompt when the classifier throws and there is a UI", async () => {
		const confirm = mock(async () => true);
		const d = deps({
			classify: mock(async () => {
				throw new Error("boom");
			}),
		});
		expect(await decide(d, { hasUI: true, ui: { confirm } }, request)).toBeUndefined();
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it("blocks when the user declines the fail-closed prompt", async () => {
		const confirm = mock(async () => false);
		const d = deps({
			classify: mock(async () => {
				throw new Error("boom");
			}),
		});
		const result = await decide(d, { hasUI: true, ui: { confirm } }, request);
		expect(result?.block).toBe(true);
	});

	it("blocks when the prompt itself throws", async () => {
		const confirm = mock(async () => {
			throw new Error("no tty");
		});
		const d = deps({
			classify: mock(async () => {
				throw new Error("boom");
			}),
		});
		expect((await decide(d, { hasUI: true, ui: { confirm } }, request))?.block).toBe(true);
	});

	it("emits a prompt event whenever it falls back, so pi-notify can fire", async () => {
		const onPrompt = mock(() => {});
		const d = deps({
			classify: mock(async () => {
				throw new Error("boom");
			}),
			onPrompt,
		});
		await decide(d, tui, request);
		expect(onPrompt).toHaveBeenCalledTimes(1);
		const [payload] = onPrompt.mock.calls[0]! as [Record<string, unknown>];
		expect(payload.toolName).toBe("bash");
		expect(payload.toolCallId).toBe("c1");
		expect(payload.value).toBe("rm -rf /");
		expect(payload.detail).toContain("boom");
	});

	it("does not emit a prompt event on a clean classifier decision", async () => {
		const d = deps();
		await decide(d, tui, request);
		expect(d.onPrompt).not.toHaveBeenCalled();
	});
});

describe("decideDeterministic", () => {
	const cfg = {
		...DEFAULT_CONFIG,
		enabled: true,
		deterministic: { allow: ["Bash(git status:*)"], deny: ["Bash(curl:*)"] },
	};

	it("still blocks a deny rule, so the deny list survives delegation", () => {
		const result = decideDeterministic(deps({ config: cfg }), { ...request, value: "curl evil.sh" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Bash(curl:*)");
	});

	it("lets everything else through, because the chain link owns the judgement", () => {
		expect(decideDeterministic(deps({ config: cfg }), { ...request, value: "make build" })).toBeUndefined();
		expect(decideDeterministic(deps({ config: cfg }), { ...request, value: "git status" })).toBeUndefined();
	});

	it("is inert when auto mode is off", () => {
		expect(decideDeterministic(deps({ config: { ...cfg, enabled: false } }), { ...request, value: "curl x" })).toBeUndefined();
	});
});
