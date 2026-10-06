// Which inbound asks are still owed an answer, and which one a bare
// `reply` means. Pure.
//
// Follows pi-intercom's ReplyTracker: `reply` resolves by explicit replyTo,
// then by `to`, then by the ask the current turn was started for, then by the
// only pending ask. A send to someone else while a turn is answering an ask is
// refused upstream of this (activeMismatch), because that is how a reply meant
// for one peer reached another (pi-intercom #117).
//
// Claude Code messages carry no reply id, so every one counts as an ask here:
// it can be answered with `reply`, and it expires like any other.

import type { Message } from "./broker/types.ts";
import type { PeerRef } from "./peers.ts";

export interface InboundContext {
	from: PeerRef;
	message: Message;
	receivedAt: number;
}

function senderMatches(context: InboundContext, to: string): boolean {
	return context.from.id === to || context.from.id.startsWith(to) || context.from.name?.toLowerCase() === to.toLowerCase();
}

function pickSender(pending: InboundContext[], to: string): InboundContext {
	const exact = pending.filter((c) => c.from.id === to);
	if (exact.length === 1) return exact[0]!;
	if (exact.length > 1) throw new Error(`Multiple pending asks from session ID "${to}" — specify \`replyTo\``);
	const lower = to.toLowerCase();
	const named = pending.filter((c) => c.from.name?.toLowerCase() === lower);
	if (named.length === 1) return named[0]!;
	if (named.length > 1) throw new Error(`Multiple pending asks match sender name "${to}" — specify a full session ID or \`replyTo\``);
	const prefixed = pending.filter((c) => c.from.id.startsWith(to));
	if (prefixed.length === 1) return prefixed[0]!;
	if (prefixed.length > 1) throw new Error(`Multiple pending asks match ID prefix "${to}" — use a longer session ID prefix or specify \`replyTo\``);
	throw new Error(`No pending ask from "${to}"`);
}

export class ReplyTracker {
	private readonly asks = new Map<string, InboundContext>();
	private readonly queued: InboundContext[] = [];
	private current: InboundContext | null = null;

	constructor(private readonly timeoutMs: number) {}

	/** Note an inbound message; asks become answerable. */
	record(from: PeerRef, message: Message, receivedAt = Date.now()): InboundContext {
		const context = { from, message, receivedAt };
		if (message.expectsReply) this.asks.set(message.id, context);
		return context;
	}

	/** A message was put in front of the model; the next turn answers it. */
	queueTurn(context: InboundContext): void {
		this.queued.push(context);
	}

	beginTurn(now = Date.now()): void {
		this.prune(now);
		this.current = this.queued.shift() ?? null;
	}

	endTurn(): void {
		this.current = null;
	}

	reset(): void {
		this.asks.clear();
		this.queued.length = 0;
		this.current = null;
	}

	resolve(options: { to?: string; replyTo?: string }, now = Date.now()): InboundContext {
		this.prune(now);
		if (options.replyTo) {
			const target = this.asks.get(options.replyTo);
			if (!target) throw new Error(`No pending ask with message ID "${options.replyTo}"`);
			if (options.to && !senderMatches(target, options.to)) throw new Error(`Pending ask "${options.replyTo}" is not from "${options.to}"`);
			return target;
		}
		const pending = [...this.asks.values()];
		if (options.to) return pickSender(pending, options.to);
		if (this.current) return this.current;
		if (pending.length === 1) return pending[0]!;
		if (pending.length === 0) throw new Error("No active intercom context to reply to");
		throw new Error("Multiple pending asks — specify `to`");
	}

	/** A send to someone with exactly one ask pending is that ask's answer. */
	uniqueAskFrom(peerId: string, name: string | undefined, now = Date.now()): InboundContext | null {
		this.prune(now);
		const matches = [...this.asks.values()].filter(
			(c) => c.from.id === peerId || (name !== undefined && c.from.name?.toLowerCase() === name.toLowerCase()),
		);
		return matches.length === 1 ? matches[0]! : null;
	}

	/** The ask this turn is answering, when a send would go somewhere else. */
	activeMismatch(peerId: string, now = Date.now()): InboundContext | null {
		this.prune(now);
		if (!this.current?.message.expectsReply) return null;
		return this.current.from.id === peerId ? null : this.current;
	}

	dismiss(messageId: string): void {
		this.asks.delete(messageId);
		for (let i = this.queued.length - 1; i >= 0; i--) {
			if (this.queued[i]?.message.id === messageId) this.queued.splice(i, 1);
		}
		if (this.current?.message.id === messageId) this.current = null;
	}

	pending(now = Date.now()): InboundContext[] {
		this.prune(now);
		return [...this.asks.values()].sort((a, b) => a.receivedAt - b.receivedAt);
	}

	private prune(now: number): void {
		for (const [id, context] of this.asks) {
			if (now - context.receivedAt > this.timeoutMs) this.dismiss(id);
		}
	}
}
