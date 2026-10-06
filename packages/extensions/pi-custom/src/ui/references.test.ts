import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentDirs,
	agentSuggestions,
	keywordAt,
	loadAgents,
	looselyMatches,
	parseAgentFile,
	referenceAt,
	referencesIn,
	relativeTime,
	sessionDigest,
	sessionSuggestions,
} from "./references.ts";

describe("finding references in text", () => {
	it("sees the reference being typed at the cursor", () => {
		expect(referenceAt("look at @session:abc")).toEqual({ kind: "session", query: "abc" });
		expect(referenceAt("@agent:")).toEqual({ kind: "agent", query: "" });
		expect(referenceAt("mail@agent:x")).toBeUndefined();
	});

	it("offers keywords only for a bare word after @", () => {
		expect(keywordAt("hi @se")).toBe("se");
		expect(keywordAt("hi @")).toBe("");
		expect(keywordAt("hi @src/a")).toBeUndefined();
	});

	it("collects every reference in a submitted prompt", () => {
		expect(referencesIn("@session:1 and @agent:oracle, then @session:2")).toEqual([
			{ kind: "session", value: "1" },
			{ kind: "agent", value: "oracle," },
			{ kind: "session", value: "2" },
		]);
	});
});

describe("sessions", () => {
	const now = Date.parse("2026-10-05T12:00:00Z");
	const s = (id: string, minutesAgo: number, first: string, count = 3) => ({
		id,
		path: `/s/${id}.jsonl`,
		firstMessage: first,
		modified: new Date(now - minutesAgo * 60_000),
		messageCount: count,
	});

	it("lists newest first, leaving out this session and empty ones", () => {
		const items = sessionSuggestions([s("a", 50, "old"), s("b", 5, "new"), s("me", 1, "this"), s("e", 2, "empty", 0)], "", "me", now);
		expect(items.map((i) => i.value)).toEqual(["@session:b", "@session:a"]);
		expect(items[0].description).toBe("5m ago · 3 messages");
	});

	it("matches the query loosely against name, first message and id", () => {
		const items = sessionSuggestions([s("a", 1, "fix the parser"), s("b", 1, "write docs")], "fxpar", undefined, now);
		expect(items.map((i) => i.value)).toEqual(["@session:a"]);
	});

	it("tells time the way a picker should", () => {
		expect(relativeTime(new Date(now - 30_000), now)).toBe("just now");
		expect(relativeTime(new Date(now - 3 * 86_400_000), now)).toBe("3d ago");
		expect(looselyMatches("abc", "a-b-c")).toBe(true);
	});

	it("digests user prompts and prose replies, without tool traffic", () => {
		const digest = sessionDigest([
			{ role: "user", content: "fix it" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "text", text: "Fixed." }] },
			{ role: "toolResult", content: [{ type: "text", text: "huge output" }] },
		]);
		expect(digest).toBe("User: fix it\n\nAssistant: Fixed.");
	});

	it("keeps the newest turns when the budget runs out, and says how many it dropped", () => {
		const digest = sessionDigest(
			[
				{ role: "user", content: "a".repeat(50) },
				{ role: "user", content: "b".repeat(50) },
				{ role: "user", content: "c".repeat(50) },
			],
			120,
		);
		expect(digest.startsWith("[1 earlier turns omitted]")).toBe(true);
		expect(digest).toContain("c".repeat(50));
		expect(digest).not.toContain("a".repeat(50));
	});
});

describe("agents", () => {
	it("reads name and description from frontmatter", () => {
		expect(parseAgentFile("---\nname: oracle\ndescription: wise\n---\nbody")).toEqual({ name: "oracle", description: "wise" });
		expect(parseAgentFile("no frontmatter")).toBeUndefined();
	});

	it("lets a later directory override an earlier one of the same name", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-custom-agents-"));
		const a = join(root, "builtin");
		const b = join(root, "user");
		mkdirSync(a);
		mkdirSync(b);
		writeFileSync(join(a, "o.md"), "---\nname: oracle\ndescription: builtin\n---");
		writeFileSync(join(b, "o.md"), "---\nname: oracle\ndescription: mine\n---");
		writeFileSync(join(b, "r.md"), "---\nname: researcher\ndescription: digs\n---");
		const agents = loadAgents([a, b, join(root, "missing")]);
		expect(agents).toEqual([
			{ name: "oracle", description: "mine" },
			{ name: "researcher", description: "digs" },
		]);
		expect(agentSuggestions(agents, "res").map((i) => i.value)).toEqual(["@agent:researcher"]);
		// "or" loosely matches both; the one that starts with it comes first.
		expect(agentSuggestions([{ name: "cursor-agent", description: "" }, ...agents], "or")[0].value).toBe("@agent:oracle");
	});

	it("looks where pi-subagents looks, package first and project last", () => {
		expect(agentDirs("/pkg/agents", "/repo", "/home/u", "/home/u/.pi/agent")).toEqual([
			"/pkg/agents",
			"/home/u/.pi/agent/agents",
			"/home/u/.agents",
			"/repo/.pi/agents",
			"/repo/.agents",
		]);
	});
});
