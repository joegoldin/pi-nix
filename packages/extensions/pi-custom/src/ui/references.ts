// @session: references in the prompt.
//
// @session:<id> pulls the gist of an earlier session into this turn: what you
// asked there and what the model concluded, without its tool traffic. The
// digest travels as a custom message delivered with the prompt, not pasted
// into it, so your message stays what you typed and the reference shows as
// its own collapsed card.
//
export type RefKind = "session";

export interface SessionSummary {
	id: string;
	path: string;
	name?: string;
	firstMessage: string;
	modified: Date;
	messageCount: number;
}

export interface Suggestion {
	value: string;
	label: string;
	description?: string;
}

/** The reference being typed at the cursor, if any. */
export function referenceAt(textBeforeCursor: string): { kind: RefKind; query: string } | undefined {
	const m = /(?:^|\s)@(session):([^\s]*)$/.exec(textBeforeCursor);
	return m ? { kind: m[1] as RefKind, query: m[2] } : undefined;
}

/** A bare "@" or a partial keyword, for offering the session keyword. */
export function keywordAt(textBeforeCursor: string): string | undefined {
	const m = /(?:^|\s)@([a-z]*)$/.exec(textBeforeCursor);
	return m ? m[1] : undefined;
}

/** Every reference in a submitted prompt. */
export function referencesIn(text: string): Array<{ kind: RefKind; value: string }> {
	const out: Array<{ kind: RefKind; value: string }> = [];
	for (const m of text.matchAll(/(?:^|\s)@(session):([^\s]+)/g)) {
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
