// The intercom runtime: one session's connection to its peers, over two
// transports, with one inbox.
//
// pi sessions are reached through the broker (broker/), Claude Code sessions
// through Claude's own peer registry (claude/). Whatever carried a message, it
// goes through the same steps here: drop duplicates, hand it to an `ask`
// waiting on it, note it as answerable, then hold it or put it in front of the
// model under one trigger policy. Replies are always explicit tool calls;
// nothing is sent on the model's behalf.
//
// What pi-subagents needs from an intercom provider lives here too, kept to the
// letter: the synchronous `intercom:session-identity` claim at session start,
// PI_INTERCOM_SESSION_ID, the `subagent-chat-` alias for unnamed sessions, and
// relaying `subagent:result-intercom` (acknowledged within its 500 ms) and
// `subagent:control-intercom`. Subagent traffic only ever goes to pi peers.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IntercomClient, type SendResult } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import type { Attachment, Message, MessageControl, MessageReceiptStatus, SessionInfo, SessionRegistration } from "./broker/types.ts";
import { ClaudeTransport, type InboundMessage, type InboundReceipt } from "./claude/transport.ts";
import { askTimeoutMs, type IntercomConfig } from "./config.ts";
import { gitState, handoverBody, handoverMessage } from "./handover.ts";
import {
	type ClaudeRow,
	claudeId,
	deliveryMetadata,
	formatAttachments,
	type PeerRef,
	piPeer,
	presenceName,
	resolveTarget,
	type Roster,
	rosterText,
	sameCwd,
	type Target,
} from "./peers.ts";
import { ReplyTracker } from "./reply-tracker.ts";

export const SESSION_IDENTITY_EVENT = "intercom:session-identity";
const RESULT_EVENT = "subagent:result-intercom";
const RESULT_DELIVERY_EVENT = "subagent:result-intercom-delivery";
const CONTROL_EVENT = "subagent:control-intercom";
const SESSION_ID_ENV = "PI_INTERCOM_SESSION_ID";
const STABLE_ID_ENV = "PI_INTERCOM_STABLE_ID";
const DEDUPE_MAX = 1000;
const DEDUPE_MS = 60 * 60 * 1000;
const RECONNECT_MS = [1000, 2000, 5000, 10000, 30000];
const WAKE_RESERVATION_MS = 10_000;

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export interface SendRequest {
	to?: string;
	cwd?: string;
	message: string;
	attachments?: Attachment[];
	replyTo?: string;
	supersedes?: string;
	retryOf?: string;
	/** Handovers are always new messages, never inferred replies. */
	handover?: boolean;
}

interface Entry {
	from: PeerRef;
	message: Message;
	replyCommand?: string;
	bodyText: string;
	/** Whether this answers something we sent, which is what the "replies" policy lets trigger. */
	isReply: boolean;
}

type WaiterTarget = { kind: "pi"; peerId: string; replyTo: string } | { kind: "claude"; address: string; name: string; msgId?: string; held?: boolean };
type Waiter = WaiterTarget & { resolve(m: Message): void; reject(e: Error): void };

function text(t: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text: t }], details };
}

function fail(t: string, details: Record<string, unknown> = {}): ToolResult {
	return text(t, { error: true, ...details });
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function deliveryDetails(result: SendResult): Record<string, unknown> {
	return {
		messageId: result.id,
		delivered: result.delivered,
		delivery: result.delivery,
		retryable: result.retryable,
		outcomeKnown: result.outcomeKnown,
		...(result.code ? { code: result.code } : {}),
		...(result.reason ? { reason: result.reason } : {}),
	};
}

function peerLabel(target: Target): string {
	return target.transport === "pi" ? target.session.name || target.session.id : target.row.name;
}

function targetPeer(target: Target): PeerRef {
	return target.transport === "pi"
		? piPeer(target.session)
		: { transport: "claude", id: claudeId(target.row), name: target.row.name, cwd: target.row.cwd, address: target.row.address };
}

export class Intercom {
	private client: IntercomClient | null = null;
	private connecting: Promise<IntercomClient> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private namePoll: ReturnType<typeof setInterval> | null = null;
	private claude: ClaudeTransport | null = null;
	private claudeNote: string | undefined;
	private claudeRows: ClaudeRow[] = [];

	private ctx: ExtensionContext | null = null;
	private generation = 0;
	private piSessionId: string | null = null;
	private intercomId: string | null = null;
	/** Set when pi-subagents claimed this session's id: a child, kept off Claude's list. */
	private child = false;
	private startedAt = 0;
	private model = "unknown";
	private agentRunning = false;
	private readonly activeTools = new Map<string, string>();
	private wakeAt = 0;
	private lastName: string | null = null;

	private readonly held: Entry[] = [];
	private heldTimer: ReturnType<typeof setInterval> | null = null;
	private readonly seen = new Map<string, number>();
	private readonly receipts = new Map<string, MessageReceiptStatus>();
	private waiter: Waiter | null = null;
	readonly tracker: ReplyTracker;
	private readonly askMs: number;
	private readonly previousEnvId = process.env[SESSION_ID_ENV];

	constructor(
		private readonly pi: ExtensionAPI,
		readonly config: IntercomConfig,
	) {
		this.askMs = askTimeoutMs();
		this.tracker = new ReplyTracker(this.askMs);
	}

	// ── lifecycle ─────────────────────────────────────────────────────────

	/** Session start or replacement. The identity claim has to happen synchronously, here. */
	start(ctx: ExtensionContext): void {
		this.teardownSession("Session replaced");
		this.generation++;
		this.ctx = ctx;
		this.piSessionId = ctx.sessionManager.getSessionId();
		let claimed: string | undefined;
		this.pi.events.emit(SESSION_IDENTITY_EVENT, {
			version: 1,
			claim: (id: unknown) => {
				claimed ??= (typeof id === "string" && id.trim()) || undefined;
			},
		});
		this.child = claimed !== undefined;
		this.intercomId = claimed ?? (process.env[STABLE_ID_ENV]?.trim() || this.config.stableId || this.piSessionId);
		process.env[SESSION_ID_ENV] = this.intercomId;
		this.model = ctx.model?.id ?? "unknown";
		this.startedAt = Date.now();
		this.agentRunning = false;
		this.lastName = this.identity().name;
		this.startNamePoll();
		const generation = this.generation;
		// After session_start returns, so a slow broker never delays startup.
		setTimeout(() => {
			if (generation !== this.generation) return;
			void this.connect().catch(() => this.scheduleReconnect());
			void this.startClaude(ctx, generation);
		}, 0);
	}

	async shutdown(): Promise<void> {
		this.teardownSession("Session shutting down");
		this.generation++;
		this.ctx = null;
		if (this.previousEnvId === undefined) delete process.env[SESSION_ID_ENV];
		else process.env[SESSION_ID_ENV] = this.previousEnvId;
		const claude = this.claude;
		this.claude = null;
		await claude?.stop().catch(() => undefined);
	}

	private teardownSession(reason: string): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.reconnectAttempt = 0;
		if (this.namePoll) clearInterval(this.namePoll);
		this.namePoll = null;
		this.waiter?.reject(new Error(reason));
		this.tracker.reset();
		for (const entry of this.held.splice(0)) this.receipt(entry, "expired", `${reason.toLowerCase()} before injection`);
		this.stopHeldTimer();
		this.activeTools.clear();
		this.wakeAt = 0;
		const client = this.client;
		this.client = null;
		this.connecting = null;
		void client?.disconnect().catch(() => undefined);
	}

	/** turn_start: a new session id means fork, /new or /resume replaced the session. */
	turnStart(ctx: ExtensionContext): void {
		const id = ctx.sessionManager.getSessionId();
		if (id !== this.piSessionId) {
			this.start(ctx);
			this.claude?.setSession({ sessionId: id, cwd: ctx.cwd, name: this.pi.getSessionName() });
		} else {
			this.syncIdentity();
		}
		this.tracker.beginTurn();
	}

	turnEnd(ctx: ExtensionContext, assistantFinished: boolean): void {
		this.tracker.endTurn();
		// human-first: one held message per finished assistant turn, as a steer.
		if (this.config.busyDelivery === "human-first" && ctx.hasUI && assistantFinished && this.held.length > 0 && this.agentRunning && !ctx.isIdle() && !ctx.hasPendingMessages()) {
			this.inject(this.held.shift()!, "steer");
			if (this.held.length === 0) this.stopHeldTimer();
		}
	}

	agentStart(): void {
		this.wakeAt = 0;
		this.agentRunning = true;
		this.activeTools.clear();
		this.flushHeld();
		this.syncStatus();
		this.claude?.setStatus("busy");
	}

	agentEnd(): void {
		this.agentRunning = false;
		this.activeTools.clear();
		this.syncStatus();
		this.claude?.setStatus("idle");
	}

	toolStart(id: string, name: string): void {
		this.activeTools.set(id, name);
		this.syncStatus();
	}

	toolEnd(id: string): void {
		this.activeTools.delete(id);
		this.syncStatus();
	}

	modelChanged(id: string): void {
		this.model = id;
		this.client?.updatePresence({ ...this.presence(), model: id, status: this.statusLine() });
	}

	// ── identity and presence ─────────────────────────────────────────────

	private identity(): { name: string; fallback: boolean } {
		return presenceName(this.pi.getSessionName(), this.intercomId ?? this.piSessionId ?? "");
	}

	private presence(): { name: string; runtimeFallbackAlias: boolean } {
		const { name, fallback } = this.identity();
		return { name, runtimeFallbackAlias: fallback };
	}

	private statusLine(): string {
		const tool = this.activeTools.values().next().value;
		const base = tool ? `tool:${tool}` : this.agentRunning ? "thinking" : "idle";
		return this.config.status ? `${base} · ${this.config.status}` : base;
	}

	private contextUsage(): { contextPct?: number | null; contextTokens?: number | null; contextWindow?: number } {
		const usage = this.ctx?.getContextUsage?.();
		if (!usage) return {};
		return {
			contextPct: typeof usage.percent === "number" && Number.isFinite(usage.percent) ? Math.round(usage.percent) : null,
			contextTokens: typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null,
			...(typeof usage.contextWindow === "number" && usage.contextWindow > 0 ? { contextWindow: usage.contextWindow } : {}),
		};
	}

	private registration(): SessionRegistration {
		const ctx = this.ctx;
		if (!ctx) throw new Error("Intercom runtime not initialized");
		const pane = process.env.TMUX_PANE?.trim();
		const usage = this.contextUsage();
		return {
			...this.presence(),
			cwd: ctx.cwd,
			model: this.model,
			pid: process.pid,
			startedAt: this.startedAt,
			lastActivity: Date.now(),
			status: this.statusLine(),
			...(pane ? { tmuxPane: pane } : {}),
			...(typeof usage.contextPct === "number" ? { contextPct: usage.contextPct } : {}),
			...(typeof usage.contextTokens === "number" ? { contextTokens: usage.contextTokens } : {}),
			...(usage.contextWindow ? { contextWindow: usage.contextWindow } : {}),
		};
	}

	private syncStatus(): void {
		this.client?.updatePresence({ status: this.statusLine(), ...this.contextUsage() });
	}

	private syncIdentity(): void {
		const { name } = this.identity();
		if (name === this.lastName) return;
		this.lastName = name;
		this.client?.updatePresence({ ...this.presence(), status: this.statusLine(), ...this.contextUsage() });
		this.claude?.setName(this.pi.getSessionName());
	}

	private startNamePoll(): void {
		const configured = Number(process.env.PI_INTERCOM_NAME_POLL_MS);
		const ms = Number.isFinite(configured) && configured > 0 ? configured : 1000;
		this.namePoll = setInterval(() => this.syncIdentity(), ms);
		this.namePoll.unref?.();
	}

	/** Whether `to` names this session, by any of the names it answers to. */
	isSelf(to: string): boolean {
		const wanted = to.trim().toLowerCase();
		return [this.piSessionId, this.intercomId, this.client?.sessionId, this.pi.getSessionName(), this.identity().name]
			.filter((v): v is string => Boolean(v?.trim()))
			.some((v) => v.trim().toLowerCase() === wanted);
	}

	// ── broker connection ─────────────────────────────────────────────────

	async connect(): Promise<IntercomClient> {
		if (this.client?.isConnected()) return this.client;
		if (this.connecting) return this.connecting;
		if (!this.ctx) throw new Error("Intercom runtime not initialized");
		const generation = this.generation;
		const attempt: Promise<IntercomClient> = (async () => {
			const client = new IntercomClient();
			this.attach(client);
			await spawnBrokerIfNeeded(this.config.brokerCommand, this.config.brokerArgs);
			await client.connect(this.registration(), this.intercomId ?? undefined);
			if (generation !== this.generation) {
				await client.disconnect();
				throw new Error("Intercom runtime no longer active");
			}
			this.client = client;
			this.reconnectAttempt = 0;
			return client;
		})();
		this.connecting = attempt;
		const settle = () => {
			if (this.connecting === attempt) this.connecting = null;
		};
		attempt.then(settle, settle);
		return attempt;
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || !this.ctx) return;
		const generation = this.generation;
		const delay = RECONNECT_MS[Math.min(this.reconnectAttempt, RECONNECT_MS.length - 1)]!;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (generation !== this.generation) return;
			this.reconnectAttempt++;
			void this.connect().catch(() => this.scheduleReconnect());
		}, delay);
		this.reconnectTimer.unref?.();
	}

	private attach(client: IntercomClient): void {
		client.on("message", (from: SessionInfo, message: Message) => {
			if (this.client === client) this.fromPi(from, message);
		});
		client.onMessageReceipt((_from, receipt) => this.receipts.set(receipt.messageId, receipt.status));
		client.onMessageControl((_from, control) => this.control(control));
		client.on("disconnected", (error: Error) => {
			if (this.client !== client) return;
			if (this.waiter?.kind === "pi") this.waiter.reject(new Error(`Disconnected while waiting for reply: ${error.message}`));
			this.client = null;
			this.scheduleReconnect();
		});
		// Socket noise stays out of the TUI; the disconnect path reconnects.
		client.on("error", () => {});
	}

	// ── Claude Code peering ───────────────────────────────────────────────

	private async startClaude(ctx: ExtensionContext, generation: number): Promise<void> {
		if (!this.config.claude.enabled) {
			this.claudeNote = "Claude Code peering is off (intercom config claude.enabled).";
			return;
		}
		// Subagent children and print-mode runs stay off Claude's list: a child
		// would show up as a duplicate pi-<dir>, and a one-shot run would be
		// listed only until it exits.
		if (this.child || !ctx.hasUI) {
			this.claudeNote = "Claude Code sessions are reachable from interactive top-level sessions only.";
			return;
		}
		if (this.claude) return;
		const claude = new ClaudeTransport({
			onMessage: (m) => this.fromClaude(m),
			onReceipt: (r) => this.claudeReceipt(r),
		});
		try {
			await claude.start({ sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, name: this.pi.getSessionName() });
		} catch (error) {
			this.claudeNote = `Not registered with Claude Code: ${errorText(error)}`;
			return;
		}
		if (generation !== this.generation) {
			await claude.stop().catch(() => undefined);
			return;
		}
		this.claude = claude;
		this.claudeNote = undefined;
		claude.setStatus(this.agentRunning ? "busy" : "idle");
	}

	/** Live Claude Code sessions, without pi sessions registered there too: those are reached through the broker. */
	private async claudePeers(): Promise<ClaudeRow[]> {
		if (!this.claude) return [];
		const peers = await this.claude.peers();
		this.claudeRows = peers
			.filter((p) => p.live && p.entrypoint !== "pi" && p.socketPath !== this.claude?.socketPath)
			.map((p) => ({ sessionId: p.sessionId ?? "", name: p.name, cwd: p.cwd ?? "", ...(p.status ? { status: p.status } : {}), address: p.address }));
		return this.claudeRows;
	}

	private claudeReceipt(r: InboundReceipt): void {
		const waiter = this.waiter;
		const who = r.sent?.name ?? "a Claude Code session";
		if (waiter?.kind === "claude" && waiter.msgId === r.origMsgId) {
			if (r.status === "held") {
				waiter.held = true;
				this.ctx?.ui.notify(`${who} is holding the message for approval`, "info");
				return;
			}
			if (r.status === "delivered") return;
			waiter.reject(new Error(`${who} ${r.status} the message${r.reason ? `: ${r.reason}` : ""}.`));
			return;
		}
		if (r.status === "delivered") return;
		// A send the model thinks went through was held, refused or dropped on the
		// Claude side; tell it, without starting a turn.
		this.pi.sendMessage(
			{
				customType: "intercom_notice",
				content: `Claude Code session "${who}" reported your message ${r.origMsgId} as ${r.status}${r.reason ? `: ${r.reason}` : ""}${r.status === "held" ? " (waiting for its user's approval)" : ""}.`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
	}

	// ── inbound ───────────────────────────────────────────────────────────

	private duplicate(fromId: string, messageId: string, now: number): boolean {
		for (const [key, at] of this.seen) if (now - at > DEDUPE_MS) this.seen.delete(key);
		const key = `${fromId}\0${messageId}`;
		if (this.seen.has(key)) return true;
		this.seen.set(key, now);
		while (this.seen.size > DEDUPE_MAX) {
			const oldest = this.seen.keys().next().value;
			if (typeof oldest !== "string") break;
			this.seen.delete(oldest);
		}
		return false;
	}

	/** Receipts go back over the broker; Claude peers get none (see claude/README.md). */
	private receipt(entry: Pick<Entry, "from" | "message">, status: MessageReceiptStatus, detail?: string): void {
		if (entry.from.transport === "pi") this.brokerReceipt(entry.message.id, status, detail);
	}

	private brokerReceipt(messageId: string, status: MessageReceiptStatus, detail?: string): void {
		try {
			this.client?.sendMessageReceipt({ messageId, status, timestamp: Date.now(), ...(detail ? { detail } : {}) });
		} catch {
			// Receipts are diagnostics; a gone sender is not this session's problem.
		}
	}

	private fromPi(from: SessionInfo, message: Message): void {
		if (!this.ctx) return;
		const now = Date.now();
		const peer = piPeer(from);
		if (this.duplicate(peer.id, message.id, now)) {
			this.receipt({ from: peer, message }, "acknowledged", "duplicate message id suppressed");
			return;
		}
		const received = { ...message, receiverReceivedAt: now };
		this.receipt({ from: peer, message }, "receiver_received");
		const waiter = this.waiter;
		if (
			waiter?.kind === "pi" &&
			received.replyTo === waiter.replyTo &&
			(from.id === waiter.peerId || (from.name || from.id).toLowerCase() === waiter.peerId.toLowerCase())
		) {
			this.receipt({ from: peer, message }, "acknowledged", "matched reply waiter");
			waiter.resolve(received);
			return;
		}
		this.tracker.record(peer, received, now);
		this.receipt({ from: peer, message }, "acknowledged", "accepted by receiver");
		this.route({
			from: peer,
			message: received,
			replyCommand: this.config.replyHint && received.expectsReply ? `intercom({ action: "reply", message: "..." })` : undefined,
			bodyText: `${received.content.text}${formatAttachments(received.content.attachments)}`,
			isReply: Boolean(received.replyTo),
		});
	}

	private fromClaude(m: InboundMessage): void {
		if (!this.ctx) return;
		const now = Date.now();
		const known = m.address ? this.claudeRows.find((r) => r.address === m.address) : undefined;
		const peer: PeerRef = {
			transport: "claude",
			id: claudeId({ sessionId: m.fromSession ?? known?.sessionId ?? "", address: m.address ?? m.from ?? m.fromName }),
			name: m.fromName,
			cwd: known?.cwd ?? "",
			...(m.address ? { address: m.address } : {}),
		};
		if (this.duplicate(peer.id, m.msgId, now)) return;
		// Claude has no reply ids; every message from a peer we can answer is an ask.
		const message: Message = { id: m.msgId, timestamp: now, receiverReceivedAt: now, expectsReply: Boolean(m.address), content: { text: m.body } };
		const waiter = this.waiter;
		if (waiter?.kind === "claude" && m.address === waiter.address) {
			waiter.resolve(message);
			return;
		}
		this.tracker.record(peer, message, now);
		this.route({
			from: peer,
			message,
			replyCommand: this.config.replyHint && m.address ? `intercom({ action: "reply", message: "..." })` : undefined,
			bodyText: m.body,
			isReply: Boolean(m.address && this.claude?.recentSends().some((s) => s.address === m.address)),
		});
	}

	private control(control: MessageControl): void {
		this.tracker.dismiss(control.messageId);
		const index = this.held.findIndex((e) => e.message.id === control.messageId);
		if (index >= 0) {
			const [entry] = this.held.splice(index, 1);
			this.receipt(entry!, control.action === "cancel" ? "cancelled" : "superseded", control.action === "cancel" ? "dropped before injection" : control.supersededBy);
			return;
		}
		if (control.action === "supersede") this.brokerReceipt(control.messageId, "superseded", control.supersededBy);
		if (control.action === "cancel") {
			this.brokerReceipt(control.messageId, "cancellation_requested", "message may already be injected or processed");
		}
	}

	/**
	 * Hold or deliver. A session busy without an agent run (compaction) can't
	 * take a steer, and a busy session with no one at the keyboard is finishing
	 * a task it was launched for, so both hold until idle. pi-intercom answered
	 * the second case with a canned "can't respond" sent as a reply, which the
	 * asker took for the answer.
	 */
	private route(entry: Entry): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const busy = !ctx.isIdle();
		const humanFirst = this.config.busyDelivery === "human-first" && ctx.hasUI;
		if (this.held.length > 0 || (busy && (!this.agentRunning || !ctx.hasUI || humanFirst))) {
			this.held.push(entry);
			this.receipt(entry, "queued", "held until delivery is safe");
			if (!this.heldTimer) {
				this.heldTimer = setInterval(() => this.flushHeld(), 100);
				this.heldTimer.unref?.();
			}
			return;
		}
		this.inject(entry, busy ? "steer" : "trigger");
	}

	private flushHeld(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		if (this.config.busyDelivery === "human-first" && ctx.hasUI) {
			if (ctx.isIdle() && !this.wakePending() && this.held.length > 0) this.inject(this.held.shift()!, "trigger");
		} else {
			while (this.held.length > 0) {
				if (ctx.isIdle()) this.inject(this.held.shift()!, "trigger");
				else if (this.agentRunning && ctx.hasUI) this.inject(this.held.shift()!, "steer");
				else break;
			}
		}
		if (this.held.length === 0) this.stopHeldTimer();
	}

	private stopHeldTimer(): void {
		if (this.heldTimer) clearInterval(this.heldTimer);
		this.heldTimer = null;
	}

	private wakePending(): boolean {
		return this.wakeAt > 0 && Date.now() - this.wakeAt < WAKE_RESERVATION_MS;
	}

	private triggers(entry: Entry, force: boolean): boolean {
		if (force || this.config.inboundTrigger === "always") return true;
		return this.config.inboundTrigger === "replies" && entry.isReply;
	}

	private inject(entry: Entry, delivery: "trigger" | "steer", force = false): void {
		const message = { ...entry.message, injectedAt: Date.now() };
		const replyCommand =
			delivery === "steer" && entry.replyCommand && message.expectsReply
				? `intercom({ action: "reply", replyTo: ${JSON.stringify(message.id)}, message: "..." })`
				: entry.replyCommand;
		this.tracker.queueTurn({ from: entry.from, message, receivedAt: Date.now() });
		const sender = entry.from.name || entry.from.id.slice(0, 8);
		const where = entry.from.transport === "claude" ? "Claude Code" : entry.from.cwd;
		const hint = replyCommand ? `\n\nTo reply, use the intercom tool: ${replyCommand}` : "";
		const trigger = delivery === "trigger" && this.triggers(entry, force);
		this.pi.sendMessage(
			{
				customType: "intercom_message",
				content: `**From ${sender}** (${where})${hint}\n\n_${deliveryMetadata(message)}_\n\n${entry.bodyText}`,
				display: true,
				details: { from: entry.from, message, replyCommand, bodyText: entry.bodyText },
			},
			trigger ? undefined : { deliverAs: "steer" },
		);
		// pi skips before_agent_start for sendMessage turns (pi#5581), so an idle
		// session is woken with a user prompt that runs the normal lifecycle.
		if (trigger && !this.wakePending() && this.ctx?.isIdle()) {
			this.wakeAt = Date.now();
			this.pi.sendUserMessage("New intercom message above.");
		}
		this.receipt(entry, "injected");
	}

	// ── pi-subagents relays ───────────────────────────────────────────────

	relaySubagent(payload: unknown, kind: "control" | "result"): void {
		if (typeof payload !== "object" || payload === null) return;
		const p = payload as Record<string, unknown>;
		if (typeof p.to !== "string" || typeof p.message !== "string") return;
		const to = p.to;
		const body = p.message;
		const requestId = typeof p.requestId === "string" ? p.requestId : undefined;
		const ack = (delivered: boolean, error?: unknown) => {
			if (kind !== "result" || !requestId) return;
			this.pi.events.emit(RESULT_DELIVERY_EVENT, { requestId, delivered, ...(error ? { error: errorText(error) } : {}) });
		};
		const errorEntry = kind === "result" ? "intercom_result_error" : "intercom_control_error";
		const local = () => {
			const sender = kind === "result" ? "subagent-result" : "subagent-control";
			const now = Date.now();
			this.inject(
				{
					from: { transport: "pi", id: sender, name: sender, cwd: this.ctx?.cwd ?? "" },
					message: { id: randomUUID(), timestamp: now, content: { text: body } },
					bodyText: body,
					isReply: false,
				},
				"trigger",
				true,
			);
			ack(true);
		};
		if (this.isSelf(to)) {
			local();
			return;
		}
		const generation = this.generation;
		void (async () => {
			try {
				const client = await this.connect();
				const resolved = resolveTarget(to, await client.listSessions(), []);
				if (generation !== this.generation) return;
				const id = resolved.ok && resolved.target.transport === "pi" ? resolved.target.session.id : to;
				if (id === client.sessionId || this.isSelf(id)) {
					local();
					return;
				}
				const result = await client.send(id, { text: body });
				if (!result.delivered) throw new Error(result.reason ?? "Session may not exist or has disconnected.");
				ack(true);
			} catch (error) {
				if (generation !== this.generation) return;
				this.pi.appendEntry(errorEntry, { to, message: body, error: errorText(error), timestamp: Date.now() });
				ack(false, error);
			}
		})();
	}

	subscribe(): () => void {
		const off = [
			this.pi.events.on(CONTROL_EVENT, (payload) => this.relaySubagent(payload, "control")),
			this.pi.events.on(RESULT_EVENT, (payload) => this.relaySubagent(payload, "result")),
		];
		return () => {
			for (const unsubscribe of off) unsubscribe();
		};
	}

	// ── outbound: what the tool and commands call ─────────────────────────

	async roster(): Promise<Roster> {
		const client = await this.connect();
		const sessions = await client.listSessions();
		const self = sessions.find((s) => s.id === client.sessionId);
		if (!self) throw new Error("Current session is missing from intercom session list.");
		let claude: ClaudeRow[] = [];
		let claudeNote = this.claudeNote;
		try {
			claude = await this.claudePeers();
		} catch (error) {
			claudeNote = `Could not read Claude Code's session list: ${errorText(error)}`;
		}
		return { self, pi: sessions, claude, ...(claudeNote ? { claudeNote } : {}) };
	}

	async list(cwd?: string): Promise<ToolResult> {
		try {
			const roster = await this.roster();
			const filter = cwd === undefined ? undefined : cwd && cwd !== "." ? resolve(roster.self.cwd, cwd) : roster.self.cwd;
			const { text: body, peers, total } = rosterText(roster, filter);
			return text(body, { roster: { peers, total, ...(filter ? { cwd: filter } : {}) } });
		} catch (error) {
			return fail(`Failed to list sessions: ${errorText(error)}`);
		}
	}

	private async target(to: string | undefined, cwd: string | undefined, roster: Roster): Promise<Target> {
		if (to) {
			const resolved = resolveTarget(to, roster.pi, roster.claude);
			if (!resolved.ok) throw new Error(resolved.error);
			if (cwd) {
				const where = resolved.target.transport === "pi" ? resolved.target.session.cwd : resolved.target.row.cwd;
				if (!sameCwd(where, resolve(roster.self.cwd, cwd))) throw new Error(`"${to}" is not in ${cwd}.`);
			}
			return resolved.target;
		}
		const dir = resolve(roster.self.cwd, cwd ?? ".");
		const candidates: Target[] = [
			...roster.pi.filter((s) => s.id !== roster.self.id && sameCwd(s.cwd, dir)).map((session) => ({ transport: "pi" as const, session })),
			...roster.claude.filter((r) => sameCwd(r.cwd, dir)).map((row) => ({ transport: "claude" as const, row })),
		];
		if (candidates.length === 1) return candidates[0]!;
		throw new Error(candidates.length === 0 ? `No intercom session is connected in ${dir}.` : `Several sessions are connected in ${dir}; name one with "to".`);
	}

	private async confirm(ctx: ExtensionContext, label: string, body: string): Promise<boolean> {
		if (!this.config.confirmSend || !ctx.hasUI) return true;
		return ctx.ui.confirm("Send message", `Send to "${label}":\n\n${body}`);
	}

	private fromName(): string {
		return this.pi.getSessionName()?.trim() || this.claude?.name || this.identity().name;
	}

	async send(ctx: ExtensionContext, request: SendRequest, signal?: AbortSignal): Promise<ToolResult> {
		try {
			const roster = await this.roster();
			const target = await this.target(request.to, request.cwd, roster);
			const peer = targetPeer(target);
			const label = request.to ?? peerLabel(target);
			if (target.transport === "pi" && target.session.id === roster.self.id) return fail("Cannot message the current session");
			const mismatch = request.replyTo ? null : this.tracker.activeMismatch(peer.id);
			if (mismatch) {
				const sender = mismatch.from.name || mismatch.from.id;
				return fail(
					`This turn is responding to an intercom ask from "${sender}". Use intercom({ action: "reply", message: "..." }) or set replyTo: "${mismatch.message.id}". Refusing non-reply send to "${label}" to avoid a misdirected reply.`,
					{ replyTo: mismatch.message.id },
				);
			}
			const inferred = request.replyTo || request.handover ? null : this.tracker.uniqueAskFrom(peer.id, peer.name);
			const replyTo = request.replyTo ?? inferred?.message.id;
			const attachmentText = formatAttachments(request.attachments);
			if (!replyTo && !(await this.confirm(ctx, label, `${request.message}${attachmentText}`))) return text("Message cancelled by user");
			if (request.handover && signal?.aborted) return fail("Handover was cancelled before delivery.");

			if (target.transport === "claude") {
				if (request.supersedes || request.retryOf) return fail("Claude Code peers do not support supersedes or retryOf.");
				const { msgId } = await this.sendClaude(target.row, `${request.message}${attachmentText}`);
				if (replyTo) this.tracker.dismiss(replyTo);
				this.pi.appendEntry("intercom_sent", { to: label, message: { text: request.message, replyTo }, messageId: msgId, timestamp: Date.now() });
				return text(inferred ? `Reply sent to ${label} (inferred from pending ask)` : `Message sent to ${label}`, { messageId: msgId, delivered: true, transport: "claude", ...(replyTo ? { replyTo } : {}) });
			}

			const client = await this.connect();
			const result = await client.send(target.session.id, {
				text: request.message,
				attachments: request.attachments,
				replyTo,
				supersedes: request.supersedes,
				retryOf: request.retryOf,
			});
			if (!result.delivered) return text(`Message to "${label}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, deliveryDetails(result));
			this.pi.appendEntry("intercom_sent", {
				to: label,
				message: { text: request.message, attachments: request.attachments, replyTo, supersedes: request.supersedes, retryOf: request.retryOf },
				messageId: result.id,
				timestamp: Date.now(),
			});
			if (replyTo) this.tracker.dismiss(replyTo);
			return text(inferred ? `Reply sent to ${label} (inferred from pending ask)` : `Message sent to ${label}`, {
				...deliveryDetails(result),
				...(replyTo ? { replyTo } : {}),
			});
		} catch (error) {
			return fail(`Failed to send: ${errorText(error)}`);
		}
	}

	private async sendClaude(row: ClaudeRow, body: string): Promise<{ msgId: string }> {
		if (!this.claude) throw new Error(this.claudeNote ?? "Not registered with Claude Code.");
		const peer = (await this.claude.peers()).find((p) => p.address === row.address);
		if (!peer?.live) throw new Error(`Claude Code session "${row.name}" is no longer running.`);
		return this.claude.send(peer, body, { fromName: this.fromName(), fromMode: this.config.claude.fromMode });
	}

	private waitFor(waiter: WaiterTarget, signal: AbortSignal | undefined, onAbort?: () => void): { promise: Promise<Message>; waiter: Waiter } {
		let resolveFn!: (m: Message) => void;
		let rejectFn!: (e: Error) => void;
		const promise = new Promise<Message>((resolve, reject) => {
			resolveFn = resolve;
			rejectFn = reject;
		});
		const timeout = setTimeout(() => {
			const minutes = this.askMs % 60000 === 0 ? `${this.askMs / 60000} minutes` : `${this.askMs}ms`;
			full.reject(new Error(`No reply within ${minutes}. The message may still be queued or actionable in the recipient session.`));
		}, this.askMs);
		const abort = () => {
			onAbort?.();
			full.reject(new Error("Cancelled"));
		};
		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			if (this.waiter === full) this.waiter = null;
		};
		const full = {
			...waiter,
			resolve: (m: Message) => {
				cleanup();
				resolveFn(m);
			},
			reject: (e: Error) => {
				cleanup();
				rejectFn(e);
			},
		} as Waiter;
		signal?.addEventListener("abort", abort, { once: true });
		this.waiter = full;
		promise.catch(() => undefined);
		return { promise, waiter: full };
	}

	async ask(ctx: ExtensionContext, request: SendRequest, signal?: AbortSignal): Promise<ToolResult> {
		if (this.waiter) return fail("Already waiting for a reply");
		if (signal?.aborted) return fail("Cancelled");
		let questionId: string | undefined;
		try {
			const roster = await this.roster();
			let target: Target;
			try {
				target = await this.target(request.to, request.cwd, roster);
			} catch (error) {
				return fail(
					`${errorText(error)} Blocking asks are not queued; use send for a non-blocking mailbox delivery or retry after the session reconnects.`,
				);
			}
			const label = request.to ?? peerLabel(target);
			if (target.transport === "pi" && target.session.id === roster.self.id) return fail("Cannot message the current session");
			if (this.waiter) return fail("Already waiting for a reply");
			const attachmentText = formatAttachments(request.attachments);

			if (target.transport === "claude") {
				if (request.supersedes || request.retryOf) return fail("Claude Code peers do not support supersedes or retryOf.");
				const { promise, waiter } = this.waitFor({ kind: "claude", address: target.row.address, name: target.row.name }, signal);
				let msgId: string;
				try {
					({ msgId } = await this.sendClaude(target.row, `${request.message}${attachmentText}`));
				} catch (error) {
					waiter.reject(error instanceof Error ? error : new Error(String(error)));
					throw error;
				}
				if (waiter.kind === "claude") waiter.msgId = msgId;
				this.pi.appendEntry("intercom_sent", { to: label, message: { text: request.message }, messageId: msgId, timestamp: Date.now() });
				const reply = await promise;
				this.pi.appendEntry("intercom_received", { from: label, message: { text: reply.content.text }, messageId: reply.id, timestamp: reply.timestamp });
				return text(`**Reply from ${label}:**\n${reply.content.text}`, { transport: "claude" });
			}

			const client = await this.connect();
			questionId = randomUUID();
			const id = questionId;
			const { promise, waiter } = this.waitFor({ kind: "pi", peerId: target.session.id, replyTo: id }, signal, () => client.cancelAsk(id));
			const sent = await client.send(target.session.id, {
				messageId: id,
				text: request.message,
				attachments: request.attachments,
				replyTo: request.replyTo,
				expectsReply: true,
				supersedes: request.supersedes,
				retryOf: request.retryOf,
			});
			if (!sent.delivered) {
				const reason = `Message to "${label}" was not delivered: ${sent.reason ?? "Session may not exist or has disconnected."}`;
				waiter.reject(new Error(reason));
				return fail(reason, deliveryDetails(sent));
			}
			this.pi.appendEntry("intercom_sent", {
				to: label,
				message: { text: request.message, attachments: request.attachments, replyTo: request.replyTo, supersedes: request.supersedes, retryOf: request.retryOf },
				messageId: sent.id,
				timestamp: Date.now(),
			});
			const reply = await promise;
			this.pi.appendEntry("intercom_received", {
				from: label,
				message: { text: reply.content.text, attachments: reply.content.attachments },
				messageId: reply.id,
				timestamp: reply.timestamp,
			});
			return text(`**Reply from ${label}:**\n${reply.content.text}${formatAttachments(reply.content.attachments)}`);
		} catch (error) {
			return fail(`Failed: ${errorText(error)}`, questionId ? { messageId: questionId, deliveryState: this.receipts.get(questionId) ?? "unknown" } : {});
		}
	}

	async reply(request: { to?: string; replyTo?: string; message: string; attachments?: Attachment[] }): Promise<ToolResult> {
		try {
			const context = this.tracker.resolve({ to: request.to, replyTo: request.replyTo });
			const label = context.from.name || context.from.id;
			if (context.from.transport === "claude") {
				const row = this.claudeRows.find((r) => r.address === context.from.address) ?? {
					sessionId: "",
					name: label,
					cwd: context.from.cwd,
					address: context.from.address ?? "",
				};
				if (!row.address) return fail(`"${label}" gave no address to reply to.`);
				const { msgId } = await this.sendClaude(row, `${request.message}${formatAttachments(request.attachments)}`);
				this.tracker.dismiss(context.message.id);
				this.pi.appendEntry("intercom_sent", { to: label, message: { text: request.message, replyTo: context.message.id }, messageId: msgId, timestamp: Date.now() });
				return text(`Reply sent to ${label}`, { messageId: msgId, delivered: true, replyTo: context.message.id, transport: "claude" });
			}
			const client = await this.connect();
			if (context.from.id === client.sessionId) return fail("Cannot message the current session");
			const result = await client.send(context.from.id, { text: request.message, attachments: request.attachments, replyTo: context.message.id });
			if (!result.delivered) {
				if (result.reason === "Session not found") this.tracker.dismiss(context.message.id);
				return text(`Reply to "${label}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, deliveryDetails(result));
			}
			this.tracker.dismiss(context.message.id);
			this.pi.appendEntry("intercom_sent", {
				to: label,
				message: { text: request.message, attachments: request.attachments, replyTo: context.message.id },
				messageId: result.id,
				timestamp: Date.now(),
			});
			return text(`Reply sent to ${label}`, { ...deliveryDetails(result), replyTo: context.message.id });
		} catch (error) {
			return fail(`Failed to reply: ${errorText(error)}`);
		}
	}

	pending(): ToolResult {
		const asks = this.tracker.pending();
		if (asks.length === 0) return text("No unresolved inbound asks.");
		const now = Date.now();
		const lines = asks.map(({ from, message, receivedAt }) => {
			const seconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
			const via = from.transport === "claude" ? " (Claude Code)" : "";
			return `- ${from.name || from.id}${via} · ${message.id} · ${seconds}s ago · ${message.content.text.replace(/\s+/g, " ").slice(0, 80)}`;
		});
		return text(`**Pending asks:**\n${lines.join("\n")}`);
	}

	async cancel(messageId: string): Promise<ToolResult> {
		if (this.claude?.sentRecord(messageId)) return fail(`${messageId} went to a Claude Code session; those cannot be cancelled.`, { messageId });
		try {
			const result = await (await this.connect()).cancelMessage(messageId);
			if (!result.delivered) {
				return text(`Cancellation for ${messageId} was not delivered: ${result.reason ?? "Message may not exist or may belong to another sender."}`, {
					messageId,
					delivered: false,
					reason: result.reason,
				});
			}
			return text(`Cancellation requested for ${messageId}`, { messageId, delivered: true });
		} catch (error) {
			return fail(`Failed to cancel message: ${errorText(error)}`, { messageId });
		}
	}

	async status(): Promise<ToolResult> {
		try {
			const client = await this.connect();
			const sessions = await client.listSessions();
			const claude = this.claude?.address ? `registered as "${this.claude.name}" at ${this.claude.address}` : (this.claudeNote ?? "not registered");
			return text(`**Intercom Status:**\nConnected: Yes\nSession ID: ${client.sessionId}\nActive sessions: ${sessions.length}\nClaude Code: ${claude}`);
		} catch (error) {
			return fail(`Failed to get status: ${errorText(error)}`);
		}
	}

	async handover(ctx: ExtensionContext, request: { to?: string; cwd?: string; goal?: string; text?: string }, signal?: AbortSignal): Promise<ToolResult> {
		let body = request.text;
		if (body === undefined) {
			try {
				body = await this.handoverText(ctx, request.goal, signal);
			} catch (error) {
				return fail(`Handover failed: ${errorText(error)}`);
			}
		}
		return this.send(ctx, { to: request.to, cwd: request.cwd, message: body, handover: true }, signal);
	}

	async handoverText(ctx: ExtensionContext, goal: string | undefined, signal?: AbortSignal): Promise<string> {
		const [body, git] = await Promise.all([handoverBody(ctx, goal, signal), gitState(ctx.cwd)]);
		if (signal?.aborted) throw new Error("Handover generation was aborted.");
		return handoverMessage({
			senderName: this.pi.getSessionName()?.trim() || (this.intercomId ?? ctx.sessionManager.getSessionId()).slice(0, 8),
			senderCwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			...(git ? { git } : {}),
			body,
		});
	}

	get sessionId(): string | null {
		return this.client?.sessionId ?? this.intercomId;
	}
}
