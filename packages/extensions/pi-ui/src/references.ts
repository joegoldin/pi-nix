// @session: and @agent: references in the prompt.
//
// @session:<id> pulls the gist of an earlier session into this turn: what you
// asked there and what the model concluded, without its tool traffic. The
// digest travels as a custom message delivered with the prompt, not pasted
// into it, so your message stays what you typed and the reference shows as
// its own collapsed card.
//
// @agent:<name> names a pi-subagents agent. It adds no context; it tells the
// model which agent you mean, which is the part a bare name leaves ambiguous.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RefKind = "session" | "agent";

export interface SessionSummary {
	id: string;
	path: string;
	name?: string;
	firstMessage: string;
	modified: Date;
	messageCount: number;
}

export interface AgentSummary {
	name: string;
	description: string;
}

export interface Suggestion {
	value: string;
	label: string;
	description?: string;
}

/** The reference being typed at the cursor, if any. */
export function referenceAt(textBeforeCursor: string): { kind: RefKind; query: string } | undefined {
	const m = /(?:^|\s)@(session|agent):([^\s]*)$/.exec(textBeforeCursor);
	return m ? { kind: m[1] as RefKind, query: m[2] } : undefined;
}

/** A bare "@" or a partial keyword, for offering the two keywords themselves. */
export function keywordAt(textBeforeCursor: string): string | undefined {
	const m = /(?:^|\s)@([a-z]*)$/.exec(textBeforeCursor);
	return m ? m[1] : undefined;
}

/** Every reference in a submitted prompt. */
export function referencesIn(text: string): Array<{ kind: RefKind; value: string }> {
	const out: Array<{ kind: RefKind; value: string }> = [];
	for (const m of text.matchAll(/(?:^|\s)@(session|agent):([^\s]+)/g)) {
		out.push({ kind: m[1] as RefKind, value: m[2] });
	}
	return out;
}

export function relativeTime(date: Date, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Case-insensitive subsequence match, which is what people type into a picker. */
export function looselyMatches(query: string, haystack: string): boolean {
	const q = query.toLowerCase();
	const h = haystack.toLowerCase();
	let j = 0;
	for (let i = 0; i < h.length && j < q.length; i++) if (h[i] === q[j]) j++;
	return j === q.length;
}

export function sessionSuggestions(sessions: SessionSummary[], query: string, currentId: string | undefined, now = Date.now()): Suggestion[] {
	return sessions
		.filter((s) => s.id !== currentId && s.messageCount > 0)
		.filter((s) => !query || looselyMatches(query, `${s.name ?? ""} ${s.firstMessage} ${s.id}`))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, 20)
		.map((s) => ({
			value: `@session:${s.id}`,
			label: oneLine(s.name || s.firstMessage || s.id, 60),
			description: `${relativeTime(s.modified, now)} · ${s.messageCount} messages`,
		}));
}

/** Prefix matches first, then substring, then the loose subsequence match. */
function matchRank(query: string, name: string): number {
	const q = query.toLowerCase();
	const n = name.toLowerCase();
	return n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2;
}

export function agentSuggestions(agents: AgentSummary[], query: string): Suggestion[] {
	return agents
		.filter((a) => !query || looselyMatches(query, a.name))
		.sort((a, b) => matchRank(query, a.name) - matchRank(query, b.name))
		.slice(0, 20)
		.map((a) => ({ value: `@agent:${a.name}`, label: a.name, description: oneLine(a.description, 60) }));
}

/** name and description from an agent file's frontmatter. */
export function parseAgentFile(content: string): AgentSummary | undefined {
	const fm = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!fm) return undefined;
	const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(fm[1])?.[1]?.trim();
	const name = field("name");
	return name ? { name, description: field("description") ?? "" } : undefined;
}

/**
 * The directories pi-subagents reads agents from, in its precedence order:
 * the package's own agents, the user's, then the project's. Later entries
 * with the same name win, as they do there. Agents it finds through settings
 * scan directories or other packages are not covered.
 */
export function agentDirs(builtinDir: string | undefined, cwd: string, home = homedir(), agentDir = join(home, ".pi", "agent")): string[] {
	return [builtinDir, join(agentDir, "agents"), join(home, ".agents"), join(cwd, ".pi", "agents"), join(cwd, ".agents")].filter(
		(d): d is string => !!d,
	);
}

export function loadAgents(dirs: string[]): AgentSummary[] {
	const byName = new Map<string, AgentSummary>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".md"));
		} catch {
			continue;
		}
		for (const file of files) {
			try {
				const agent = parseAgentFile(readFileSync(join(dir, file), "utf8"));
				if (agent) byName.set(agent.name, agent);
			} catch {
				// An unreadable file costs that agent, not the list.
			}
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

interface MessageLike {
	role: string;
	content: unknown;
}

function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p: { type?: string }) => p?.type === "text")
		.map((p: { text?: string }) => p.text ?? "")
		.join("\n");
}

/**
 * The gist of a session: user prompts and the model's prose replies, newest
 * kept when the budget runs out. Tool calls and results are left out; they
 * are the bulk of a session and the least of its meaning.
 */
export function sessionDigest(messages: MessageLike[], budgetChars = 24000): string {
	const turns: string[] = [];
	for (const m of messages) {
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text = textParts(m.content).trim();
		if (!text) continue;
		turns.push(`${m.role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	const kept: string[] = [];
	let used = 0;
	for (let i = turns.length - 1; i >= 0; i--) {
		if (used + turns[i].length > budgetChars && kept.length > 0) break;
		kept.unshift(turns[i].length > budgetChars ? `${turns[i].slice(0, budgetChars)}…` : turns[i]);
		used += turns[i].length;
	}
	const dropped = turns.length - kept.length;
	return [dropped > 0 ? `[${dropped} earlier turns omitted]` : "", ...kept].filter(Boolean).join("\n\n");
}
