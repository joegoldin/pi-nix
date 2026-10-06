// Who intercom can talk to, and how a `to` string picks one. Pure.
//
// Two rosters sit behind one tool. pi sessions come from the broker, keyed by
// their intercom id. Claude Code sessions come from Claude's own registry,
// keyed by their socket address. A bare name is looked up in both, so the
// model can say `to: "dotfiles"` either way; when that is ambiguous the error
// names both spellings, `pi:<name>` and `claude:<name>`, rather than guessing.
//
// The pi half keeps pi-intercom's rules and wording, which pi-subagents and the
// model already rely on: exact id, then case-insensitive name, then a unique id
// prefix, and list rows that show the shortest unique id prefix.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Attachment, Message, SessionInfo } from "./broker/types.ts";

/** A Claude Code session as intercom lists it. */
export interface ClaudeRow {
	sessionId: string;
	name: string;
	cwd: string;
	status?: string;
	/** `uds:` address, what Claude's SendMessage accepts and what we send to. */
	address: string;
}

export type Target = { transport: "pi"; session: SessionInfo } | { transport: "claude"; row: ClaudeRow };

/** The peer a message came from, whichever transport carried it. */
export interface PeerRef {
	transport: "pi" | "claude";
	id: string;
	name?: string;
	cwd: string;
	/** Claude peers only: where a reply goes. */
	address?: string;
}

const UNNAMED_PREFIX = "subagent-chat";

/**
 * The name peers see for this session. An unnamed session gets
 * `subagent-chat-<first 18 of its id>`, the alias pi-subagents computes on its
 * side to address a parent (intercom-bridge.js resolveIntercomSessionTarget);
 * the two have to agree character for character.
 */
export function presenceName(sessionName: string | undefined, sessionId: string): { name: string; fallback: boolean } {
	const named = sessionName?.trim();
	if (named) return { name: named, fallback: false };
	const id = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
	return { name: `${UNNAMED_PREFIX}-${id.slice(0, 18)}`, fallback: true };
}

export function piPeer(session: SessionInfo): PeerRef {
	return { transport: "pi", id: session.id, ...(session.name ? { name: session.name } : {}), cwd: session.cwd };
}

export function claudePeer(row: ClaudeRow): PeerRef {
	return { transport: "claude", id: claudeId(row), name: row.name, cwd: row.cwd, address: row.address };
}

/** Claude peers' id in intercom: stable across renames, distinct from any pi id. */
export function claudeId(row: Pick<ClaudeRow, "sessionId" | "address">): string {
	return `claude:${row.sessionId || row.address}`;
}

/** Shortest prefix of each id that no other id shares, at least 8, extended to the next "-". */
export function idPrefixes(ids: string[]): Map<string, string> {
	const prefixes = new Map<string, string>();
	for (const id of ids) {
		let shared = 0;
		for (const other of ids) {
			if (other === id) continue;
			let n = 0;
			while (n < id.length && id[n] === other[n]) n++;
			shared = Math.max(shared, n);
		}
		const min = Math.max(8, shared + 1);
		const dash = id.indexOf("-", min);
		prefixes.set(id, id.slice(0, dash === -1 ? min : dash));
	}
	return prefixes;
}

export function normalizeCwd(cwd: string): string {
	const resolved = resolve(cwd);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

export function sameCwd(a: string, b: string): boolean {
	return normalizeCwd(a) === normalizeCwd(b);
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
	const k = tokens / 1000;
	return `${k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "")}k`;
}

function contextUsage(session: SessionInfo): string {
	if (typeof session.contextPct !== "number") return "";
	const detail =
		typeof session.contextTokens === "number" && typeof session.contextWindow === "number" && session.contextWindow > 0
			? ` (${formatTokens(session.contextTokens)}/${formatTokens(session.contextWindow)})`
			: "";
	return ` · ${session.contextPct}% ctx${detail}`;
}

export function piRow(session: SessionInfo, currentCwd: string, isSelf: boolean, idPrefix: string): string {
	const tags = [isSelf ? "self" : sameCwd(session.cwd, currentCwd) ? "same cwd" : undefined, session.status].filter(
		(t): t is string => Boolean(t),
	);
	const pane = session.tmuxPane ? ` · tmux ${session.tmuxPane}` : "";
	return `• ${session.name || "Unnamed session"} (${idPrefix}) — ${session.cwd} (${session.model}${contextUsage(session)}${pane})${tags.length ? ` [${tags.join(", ")}]` : ""}`;
}

export function claudeRow(row: ClaudeRow, currentCwd: string): string {
	const tags = [sameCwd(row.cwd, currentCwd) ? "same cwd" : undefined, row.status].filter((t): t is string => Boolean(t));
	return `• ${row.name} (claude:${row.name}) — ${row.cwd} (Claude Code)${tags.length ? ` [${tags.join(", ")}]` : ""}`;
}

export interface Roster {
	self: SessionInfo;
	pi: SessionInfo[];
	claude: ClaudeRow[];
	/** Why the Claude side is missing, when it is. */
	claudeNote?: string;
}

/** The text `list` and `list-cwd` return. */
export function rosterText(roster: Roster, filterCwd?: string): { text: string; peers: number; total: number } {
	const prefixes = idPrefixes(roster.pi.map((s) => s.id));
	const others = roster.pi.filter((s) => s.id !== roster.self.id && (!filterCwd || sameCwd(s.cwd, filterCwd)));
	const claude = roster.claude.filter((r) => !filterCwd || sameCwd(r.cwd, filterCwd));
	const where = filterCwd ? ` (cwd: ${filterCwd})` : "";
	const sections = [`**Current session:**\n${piRow(roster.self, roster.self.cwd, true, prefixes.get(roster.self.id) ?? roster.self.id)}`];
	sections.push(
		`**Other pi sessions${where}:**\n${
			others.length
				? others.map((s) => piRow(s, roster.self.cwd, false, prefixes.get(s.id) ?? s.id)).join("\n")
				: filterCwd
					? "No other sessions in this directory."
					: "No other sessions connected."
		}`,
	);
	sections.push(
		`**Claude Code sessions${where}:**\n${
			roster.claudeNote ?? (claude.length ? claude.map((r) => claudeRow(r, roster.self.cwd)).join("\n") : "None running.")
		}`,
	);
	return { text: sections.join("\n\n"), peers: others.length + claude.length, total: roster.pi.length + roster.claude.length };
}

export type Resolution = { ok: true; target: Target } | { ok: false; error: string };

function matchName(name: string | undefined, wanted: string): boolean {
	return Boolean(name) && name!.toLowerCase() === wanted.toLowerCase();
}

function resolveClaude(rows: ClaudeRow[], to: string): Resolution | undefined {
	const byId = rows.find((r) => r.sessionId === to || r.address === to || claudeId(r) === to);
	if (byId) return { ok: true, target: { transport: "claude", row: byId } };
	const byName = rows.filter((r) => matchName(r.name, to));
	if (byName.length === 1) return { ok: true, target: { transport: "claude", row: byName[0]! } };
	if (byName.length > 1) return { ok: false, error: `Multiple Claude Code sessions are named "${to}". Address one by its session id.` };
	const byPrefix = rows.filter((r) => r.sessionId.startsWith(to));
	if (byPrefix.length === 1) return { ok: true, target: { transport: "claude", row: byPrefix[0]! } };
	return undefined;
}

function resolvePi(sessions: SessionInfo[], to: string): Resolution | undefined {
	const byId = sessions.find((s) => s.id === to);
	if (byId) return { ok: true, target: { transport: "pi", session: byId } };
	const byName = sessions.filter((s) => matchName(s.name, to));
	if (byName.length > 1) {
		const prefixes = idPrefixes(sessions.map((s) => s.id));
		const ids = byName.map((s) => prefixes.get(s.id)!).join(", ");
		return { ok: false, error: `Multiple sessions named "${to}" are connected. Address one by the id shown in parentheses by "list" (${ids}).` };
	}
	if (byName.length === 1) return { ok: true, target: { transport: "pi", session: byName[0]! } };
	const byPrefix = sessions.filter((s) => s.id.startsWith(to));
	if (byPrefix.length === 1) return { ok: true, target: { transport: "pi", session: byPrefix[0]! } };
	if (byPrefix.length > 1) return { ok: false, error: `Multiple sessions match ID prefix "${to}". Use a longer session ID prefix.` };
	return undefined;
}

/**
 * Pick the peer a `to` names. `claude:` and `pi:` force a roster, a `uds:`
 * address is always Claude's, and a bare string is tried against pi first by
 * exact id, then against both by name, refusing a name both rosters hold.
 */
export function resolveTarget(to: string, sessions: SessionInfo[], claude: ClaudeRow[]): Resolution {
	const wanted = to.trim();
	const notFound: Resolution = { ok: false, error: `Session "${wanted}" is not connected.` };
	if (wanted.startsWith("claude:")) return resolveClaude(claude, wanted.slice("claude:".length)) ?? resolveClaude(claude, wanted) ?? notFound;
	if (wanted.startsWith("pi:")) return resolvePi(sessions, wanted.slice("pi:".length)) ?? notFound;
	if (wanted.startsWith("uds:")) return resolveClaude(claude, wanted) ?? notFound;
	const exact = sessions.find((s) => s.id === wanted);
	if (exact) return { ok: true, target: { transport: "pi", session: exact } };
	const piByName = sessions.filter((s) => matchName(s.name, wanted));
	const claudeByName = claude.filter((r) => matchName(r.name, wanted));
	if (piByName.length > 0 && claudeByName.length > 0) {
		return { ok: false, error: `"${wanted}" names both a pi session and a Claude Code session. Use "pi:${wanted}" or "claude:${wanted}".` };
	}
	return resolvePi(sessions, wanted) ?? resolveClaude(claude, wanted) ?? notFound;
}

export function formatAttachments(attachments: Attachment[] | undefined): string {
	let text = "";
	for (const att of attachments ?? []) {
		text += att.language
			? `\n\n---\nAttachment: ${att.name}\n~~~${att.language}\n${att.content}\n~~~`
			: `\n\n---\nAttachment: ${att.name}\n${att.content}`;
	}
	return text;
}

function iso(timestamp: number | undefined): string | undefined {
	return typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/** The italic line under an inbound message's header, as pi-intercom wrote it. */
export function deliveryMetadata(message: Message): string {
	const parts = [`id ${message.id}`];
	if (typeof message.senderSequence === "number") parts.push(`seq ${message.senderSequence}`);
	if (message.supersedes) parts.push(`supersedes ${message.supersedes}`);
	if (message.retryOf) parts.push(`retry of ${message.retryOf}`);
	const stamps: Array<[string, number | undefined]> = [
		["sent", message.timestamp],
		["broker delivered", message.brokerDeliveredAt],
		["receiver received", message.receiverReceivedAt],
		["injected", message.injectedAt],
	];
	for (const [label, at] of stamps) {
		const when = iso(at);
		if (when) parts.push(`${label} ${when}`);
	}
	return parts.join(" · ");
}

export function preview(value: unknown, max = 72): string | undefined {
	if (typeof value !== "string") return undefined;
	const flat = value.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
