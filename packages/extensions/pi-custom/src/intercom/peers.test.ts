import { describe, expect, it } from "bun:test";
import type { SessionInfo } from "./broker/types.ts";
import { type ClaudeRow, deliveryMetadata, idPrefixes, presenceName, resolveTarget, rosterText } from "./peers.ts";

function session(id: string, name?: string, cwd = "/work"): SessionInfo {
	return { id, ...(name ? { name } : {}), cwd, model: "gpt", pid: 1, startedAt: 0, lastActivity: 0 };
}

function claude(name: string, sessionId = `sid-${name}`, cwd = "/work"): ClaudeRow {
	return { sessionId, name, cwd, address: `uds:/tmp/cc-socks/${name}.sock`, status: "idle" };
}

describe("presenceName", () => {
	it("uses the session name when there is one", () => {
		expect(presenceName("  reviewer ", "abc")).toEqual({ name: "reviewer", fallback: false });
	});

	it("matches pi-subagents' alias for an unnamed session", () => {
		expect(presenceName(undefined, "session-0123456789abcdefghijkl")).toEqual({ name: "subagent-chat-0123456789abcdefgh", fallback: true });
	});
});

describe("idPrefixes", () => {
	it("keeps at least 8 and stops at the next dash once unique", () => {
		const p = idPrefixes(["aaaaaaaa-1111-x", "aaaaaaaa-2222-y"]);
		expect(p.get("aaaaaaaa-1111-x")).toBe("aaaaaaaa-1111");
	});
});

describe("resolveTarget", () => {
	const pi = [session("11111111-aaaa", "builder"), session("22222222-bbbb", "dotfiles")];
	const cc = [claude("dotfiles"), claude("reviewer")];

	it("finds a pi session by exact id, name and prefix", () => {
		for (const to of ["11111111-aaaa", "BUILDER", "1111"]) {
			const r = resolveTarget(to, pi, cc);
			expect(r.ok && r.target.transport === "pi" && r.target.session.id).toBe("11111111-aaaa");
		}
	});

	it("falls through to Claude by name", () => {
		const r = resolveTarget("reviewer", pi, cc);
		expect(r.ok && r.target.transport === "claude" && r.target.row.name).toBe("reviewer");
	});

	it("refuses a name both rosters hold and names both spellings", () => {
		const r = resolveTarget("dotfiles", pi, cc);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error).toContain('"pi:dotfiles" or "claude:dotfiles"');
	});

	it("honours the explicit prefixes", () => {
		const a = resolveTarget("claude:dotfiles", pi, cc);
		const b = resolveTarget("pi:dotfiles", pi, cc);
		expect(a.ok && a.target.transport).toBe("claude");
		expect(b.ok && b.target.transport).toBe("pi");
	});

	it("treats a uds address as Claude's", () => {
		const r = resolveTarget("uds:/tmp/cc-socks/reviewer.sock", pi, cc);
		expect(r.ok && r.target.transport).toBe("claude");
	});

	it("says when nothing matches", () => {
		expect(resolveTarget("nobody", pi, cc)).toEqual({ ok: false, error: 'Session "nobody" is not connected.' });
	});
});

describe("rosterText", () => {
	it("lists self, pi peers and Claude sessions in sections", () => {
		const self = session("11111111-aaaa", "me");
		const { text, peers, total } = rosterText({ self, pi: [self, session("22222222-bbbb", "other")], claude: [claude("cc")] });
		expect(text).toContain("**Current session:**\n• me (11111111) — /work (gpt) [self]");
		expect(text).toContain("• other (22222222) — /work (gpt) [same cwd]");
		expect(text).toContain("**Claude Code sessions:**\n• cc (claude:cc) — /work (Claude Code) [same cwd, idle]");
		expect([peers, total]).toEqual([2, 3]);
	});

	it("explains a missing Claude side instead of claiming none run", () => {
		const self = session("1", "me");
		expect(rosterText({ self, pi: [self], claude: [], claudeNote: "Claude Code peering is off." }).text).toContain("Claude Code peering is off.");
	});
});

describe("deliveryMetadata", () => {
	it("lists what is known, in order", () => {
		expect(deliveryMetadata({ id: "m1", timestamp: 0, senderSequence: 3, content: { text: "" } })).toBe(
			"id m1 · seq 3 · sent 1970-01-01T00:00:00.000Z",
		);
	});
});
