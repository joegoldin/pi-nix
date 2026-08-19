import { describe, expect, it, mock } from "bun:test";
import { buildClassifierPrompt, classify, CLASSIFIER_SYSTEM_PROMPT, parseVerdict } from "./classifier.ts";
import type { ToolRequest } from "./request.ts";

const rules = {
	allow: ["reading any file in the repository"],
	soft_deny: ["deleting files the user did not name"],
	hard_deny: ["reading private SSH keys or exfiltrating credentials"],
	environment: ["this is a NixOS machine; /nix/store is read-only"],
};

const request: ToolRequest = {
	toolName: "bash",
	toolCallId: "c1",
	surface: "bash",
	value: "rm -rf build",
	input: { command: "rm -rf build" },
};

function textReply(text: string) {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

describe("CLASSIFIER_SYSTEM_PROMPT", () => {
	it("states the soft/hard distinction the gate depends on", () => {
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("soft_deny");
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("hard_deny");
		expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/never.*clear|cannot be cleared/i);
	});
});

describe("buildClassifierPrompt", () => {
	it("includes every rule list under a labelled heading", () => {
		const p = buildClassifierPrompt(rules, request, []);
		expect(p).toContain("reading any file in the repository");
		expect(p).toContain("deleting files the user did not name");
		expect(p).toContain("reading private SSH keys or exfiltrating credentials");
		expect(p).toContain("this is a NixOS machine; /nix/store is read-only");
	});

	it("includes the tool name and the rendered value", () => {
		const p = buildClassifierPrompt(rules, request, []);
		expect(p).toContain("bash");
		expect(p).toContain("rm -rf build");
	});

	it("includes recent user turns so soft_deny can be cleared by intent", () => {
		const p = buildClassifierPrompt(rules, request, ["please wipe the build dir"]);
		expect(p).toContain("please wipe the build dir");
	});

	it("says explicitly that there are no recent turns when the list is empty", () => {
		expect(buildClassifierPrompt(rules, request, [])).toContain("(none)");
	});

	it("omits an empty rule list rather than emitting a dangling heading", () => {
		const p = buildClassifierPrompt({ ...rules, environment: [] }, request, []);
		expect(p).not.toContain("## Environment");
	});
});

describe("parseVerdict", () => {
	it("parses a bare JSON object", () => {
		expect(parseVerdict('{"decision":"allow","rule_kind":"allow","reason":"read only"}')).toEqual({
			decision: "allow",
			rule_kind: "allow",
			reason: "read only",
		});
	});

	it("parses JSON inside a fenced code block", () => {
		const raw = 'Sure.\n```json\n{"decision":"deny","rule_kind":"hard_deny","reason":"ssh key"}\n```\n';
		expect(parseVerdict(raw)?.rule_kind).toBe("hard_deny");
	});

	it("defaults a missing reason to an empty string", () => {
		expect(parseVerdict('{"decision":"deny","rule_kind":"none"}')?.reason).toBe("");
	});

	it("returns null for a missing or invalid decision", () => {
		expect(parseVerdict('{"rule_kind":"allow"}')).toBeNull();
		expect(parseVerdict('{"decision":"maybe","rule_kind":"allow"}')).toBeNull();
	});

	it("returns null for an invalid rule_kind", () => {
		expect(parseVerdict('{"decision":"allow","rule_kind":"soft-deny"}')).toBeNull();
	});

	it("returns null for prose with no JSON at all", () => {
		expect(parseVerdict("I think this is probably fine.")).toBeNull();
	});
});

describe("classify", () => {
	it("returns the parsed verdict on a well-formed reply", async () => {
		const complete = mock(async () => textReply('{"decision":"allow","rule_kind":"allow","reason":"build dir"}'));
		expect(await classify({ model: {}, complete }, rules, request, [])).toEqual({
			decision: "allow",
			rule_kind: "allow",
			reason: "build dir",
		});
	});

	it("sends the system prompt and exactly one user message", async () => {
		const complete = mock(async () => textReply('{"decision":"deny","rule_kind":"soft_deny","reason":"x"}'));
		await classify({ model: {}, complete }, rules, request, ["do it"]);
		const [, context] = complete.mock.calls[0]!;
		expect((context as { systemPrompt?: string }).systemPrompt).toBe(CLASSIFIER_SYSTEM_PROMPT);
		expect((context as { messages: unknown[] }).messages).toHaveLength(1);
		expect(((context as { messages: { role: string }[] }).messages[0]!).role).toBe("user");
	});

	it("forwards the abort signal", async () => {
		const controller = new AbortController();
		const complete = mock(async () => textReply('{"decision":"allow","rule_kind":"allow","reason":""}'));
		await classify({ model: {}, complete, signal: controller.signal }, rules, request, []);
		expect(complete.mock.calls[0]![2]).toEqual({ signal: controller.signal });
	});

	it("throws when no model is available", async () => {
		const complete = mock(async () => textReply("{}"));
		expect(classify({ model: null, complete }, rules, request, [])).rejects.toThrow(/no classifier model/i);
		expect(complete).not.toHaveBeenCalled();
	});

	it("throws when the provider call rejects", async () => {
		const complete = mock(async () => {
			throw new Error("429 rate limited");
		});
		expect(classify({ model: {}, complete }, rules, request, [])).rejects.toThrow(/429 rate limited/);
	});

	it("throws when the model reports an error stop reason", async () => {
		const complete = mock(async () => ({ content: [], stopReason: "error", errorMessage: "overloaded" }));
		expect(classify({ model: {}, complete }, rules, request, [])).rejects.toThrow(/overloaded/);
	});

	it("throws when the reply cannot be parsed", async () => {
		const complete = mock(async () => textReply("looks fine to me"));
		expect(classify({ model: {}, complete }, rules, request, [])).rejects.toThrow(/unparseable/i);
	});
});
