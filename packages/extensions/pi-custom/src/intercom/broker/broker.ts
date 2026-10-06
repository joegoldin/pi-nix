// The intercom broker: one process per agent dir that every pi session
// connects to, keeping the roster and routing messages between sessions.
// Ported from pi-intercom 0.16.1's broker/broker.ts (MIT, Nico Bailon), speaking
// the same protocol ("pi-intercom" version 1).
//
// Run as `bun <abs path>/broker.ts` by spawn.ts, detached from the session that
// started it; it exits 5 s after the last session leaves. It imports nothing
// but its siblings in this directory, so it runs without pi.
//
// Differences from upstream, each deliberate:
//   - A register that claims a live session's id is refused and the newcomer's
//     socket closed; upstream evicted the incumbent and handed over its
//     identity and mailbox (pi-nix's security patch, now in the code).
//   - Ask edges are dropped when either end disconnects or unregisters.
//     Upstream never called clearAskEdgesForSession, so an asker that crashed
//     and came back under the same id was refused E_MUTUAL_ASK by the peer it
//     had asked until the ask timed out.
//   - The extension bus, outbox provenance and cross-machine relays are gone,
//     and frames for them are rejected with E_INVALID_MESSAGE, not ignored.
//   - Only the Unix socket transport; no write-only pending-ask files on disk.

import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { createMessageReader, writeMessage } from "./framing.ts";
import {
	assertNoLiveBroker,
	ensureIntercomRuntimeDir,
	getBrokerPidPath,
	getBrokerSocketPath,
	getIntercomDirPath,
	INTERCOM_PROTOCOL_NAME,
	INTERCOM_PROTOCOL_VERSION,
	INTERCOM_RUNTIME_FILE_MODE,
	restrictIntercomRuntimeFile,
	sameCwd,
} from "./paths.ts";
import {
	DROPPED_MESSAGE_FIELDS,
	getAskTimeoutMs,
	isMessage,
	isMessageReceipt,
	isSessionId,
	isSessionRegistration,
	messageDeliveryFingerprint,
} from "./protocol.ts";
import { type BrokerMessage, type DeliveryState, EXACT_SEND_FEATURE, type Message, type MessageControl, type SessionInfo } from "./types.ts";

const INTERCOM_DIR = getIntercomDirPath();
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = getBrokerPidPath(INTERCOM_DIR);
const MAX_SESSIONS = 128;
const MAX_UNREGISTERED_CONNECTIONS = 32;
const REGISTRATION_TIMEOUT_MS = 1000;
const RATE_LIMIT_CAPACITY = 240;
const RATE_LIMIT_REFILL_PER_SECOND = 120;
const PRESENCE_HEARTBEAT_MS = 1000;
const IDLE_SHUTDOWN_MS = 5000;
const MESSAGE_RECEIPT_ROUTE_RETENTION_MS = 60 * 60 * 1000;
const DISCONNECTED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAILBOX_MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_MAILBOX_MESSAGES = 256;
const DELIVERY_RECORD_RETENTION_MS = 60 * 60 * 1000;
const MAX_DELIVERY_RECORDS = 4096;

// Message types an upstream pi-intercom peer may send for the extension bus,
// which this broker does not implement. Named so the rejection says why.
const DROPPED_CLIENT_MESSAGE_TYPES = new Set(["extension_capabilities_update", "extension_publish", "extension_state_commit"]);

interface ConnectedSession {
	socket: net.Socket;
	info: SessionInfo;
	key: string;
	scopeId?: string;
	lastPresenceBroadcastAt: number;
}

interface DeliveryRecord {
	fingerprint: string;
	state: DeliveryState;
	reason?: string;
	code?: string;
	retryable: boolean;
	outcomeKnown: boolean;
	createdAt: number;
}

interface ConnectionState {
	tokens: number;
	lastRefillAt: number;
}

/** An outstanding ask: `from` waits for a reply from `to`. Keys are session keys. */
interface AskEdge {
	from: string;
	to: string;
	createdAt: number;
}

interface MessageReceiptRoute {
	from: string;
	to: string;
	createdAt: number;
}

interface DisconnectedSession {
	info: SessionInfo;
	key: string;
	scopeId?: string;
	disconnectedAt: number;
}

interface MailboxMessage {
	from: SessionInfo;
	fromKey: string;
	fromScopeId?: string;
	target: SessionInfo;
	targetKey: string;
	targetScopeId?: string;
	message: Message;
	queuedAt: number;
}

function normalizeScopeId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("Invalid register scopeId");
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function sameScope(a: string | undefined, b: string | undefined): boolean {
	return a === b;
}

function scopedSessionKey(scopeId: string | undefined, sessionId: string): string {
	return JSON.stringify([scopeId ?? null, sessionId]);
}

class IntercomBroker {
	private sessions = new Map<string, ConnectedSession>();
	private askEdges = new Map<string, AskEdge>();
	private messageReceiptRoutes = new Map<string, MessageReceiptRoute>();
	private disconnectedSessions = new Map<string, DisconnectedSession>();
	private mailboxMessages: MailboxMessage[] = [];
	private deliveryRecords = new Map<string, DeliveryRecord>();
	private unregisteredConnections = new Set<net.Socket>();
	private server: net.Server;
	private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly askTimeoutMs = getAskTimeoutMs();

	constructor() {
		ensureIntercomRuntimeDir(INTERCOM_DIR);
		assertNoLiveBroker(PID_PATH);
		try {
			unlinkSync(SOCKET_PATH);
		} catch {
			// A clean startup has no stale socket to remove.
		}
		this.server = net.createServer(this.handleConnection.bind(this));
	}

	start(): void {
		this.server.listen(SOCKET_PATH, () => {
			restrictIntercomRuntimeFile(SOCKET_PATH);
			writeFileSync(PID_PATH, String(process.pid), { mode: INTERCOM_RUNTIME_FILE_MODE });
			restrictIntercomRuntimeFile(PID_PATH);
			console.log(`Intercom broker started (pid: ${process.pid})`);
		});
		process.on("SIGTERM", () => this.shutdown());
		process.on("SIGINT", () => this.shutdown());
	}

	private handleConnection(socket: net.Socket): void {
		// Attached first and never removed, so an ECONNRESET at any point in the
		// socket's life is logged instead of crashing the broker.
		socket.on("error", (error) => {
			console.error("Socket error:", error);
		});
		let sessionKey: string | null = null;
		let registrationTimeout: ReturnType<typeof setTimeout> | null = null;
		const armRegistrationTimeout = () => {
			if (registrationTimeout) clearTimeout(registrationTimeout);
			this.unregisteredConnections.delete(socket);
			this.unregisteredConnections.add(socket);
			this.evictOldestUnregisteredConnections(socket);
			registrationTimeout = setTimeout(() => {
				if (!sessionKey) socket.destroy();
			}, REGISTRATION_TIMEOUT_MS);
			registrationTimeout.unref?.();
		};
		const clearRegistrationTimeout = () => {
			if (registrationTimeout) {
				clearTimeout(registrationTimeout);
				registrationTimeout = null;
			}
			this.unregisteredConnections.delete(socket);
		};
		armRegistrationTimeout();
		const connection: ConnectionState = { tokens: RATE_LIMIT_CAPACITY, lastRefillAt: Date.now() };

		const reader = createMessageReader(
			(msg) => {
				if (!this.consumeToken(connection)) {
					writeMessage(socket, { type: "error", error: "Intercom broker rate limit exceeded" });
					socket.destroy(new Error("Intercom broker rate limit exceeded"));
					return;
				}
				this.handleMessage(socket, msg, sessionKey, (key) => {
					sessionKey = key;
					if (key) clearRegistrationTimeout();
					else armRegistrationTimeout();
				});
			},
			(error) => socket.destroy(error),
		);
		socket.on("data", reader);

		socket.on("close", () => {
			clearRegistrationTimeout();
			if (sessionKey) this.removeSession(sessionKey, socket);
		});
	}

	/** Shared by close and unregister: the session leaves the roster but stays addressable for queued mail. */
	private removeSession(key: string, socket: net.Socket): void {
		const existing = this.sessions.get(key);
		if (existing?.socket !== socket) return;
		this.rememberDisconnectedSession(existing);
		this.sessions.delete(key);
		this.clearMessageReceiptRoutesForSession(key);
		this.clearAskEdgesForSession(key);
		this.broadcast({ type: "session_left", sessionId: existing.info.id }, key, existing.scopeId);
		this.scheduleShutdownCheck();
	}

	private evictOldestUnregisteredConnections(currentSocket: net.Socket): void {
		while (this.unregisteredConnections.size > MAX_UNREGISTERED_CONNECTIONS) {
			const [oldest] = this.unregisteredConnections;
			if (!oldest) return;
			if (oldest === currentSocket && this.unregisteredConnections.size === 1) return;
			this.unregisteredConnections.delete(oldest);
			oldest.destroy();
		}
	}

	private consumeToken(connection: ConnectionState, now = Date.now()): boolean {
		const elapsedMs = now - connection.lastRefillAt;
		if (elapsedMs > 0) {
			connection.tokens = Math.min(RATE_LIMIT_CAPACITY, connection.tokens + (elapsedMs * RATE_LIMIT_REFILL_PER_SECOND) / 1000);
			connection.lastRefillAt = now;
		}
		if (connection.tokens < 1) return false;
		connection.tokens -= 1;
		return true;
	}

	private scheduleShutdownCheck(): void {
		if (this.shutdownTimer) return;
		this.shutdownTimer = setTimeout(() => {
			this.shutdownTimer = null;
			if (this.sessions.size === 0) {
				console.log("No sessions connected, shutting down");
				this.shutdown();
			}
		}, IDLE_SHUTDOWN_MS);
	}

	private handleMessage(socket: net.Socket, msg: unknown, currentKey: string | null, setKey: (key: string | null) => void): void {
		if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
			throw new Error("Invalid client message");
		}
		const clientMessage = msg as { type: string } & Record<string, unknown>;

		if (clientMessage.type === "health") {
			if (typeof clientMessage.requestId !== "string") throw new Error("Invalid health message");
			writeMessage(socket, {
				type: "health_ok",
				requestId: clientMessage.requestId,
				protocol: INTERCOM_PROTOCOL_NAME,
				version: INTERCOM_PROTOCOL_VERSION,
			});
			return;
		}

		if (currentKey === null && clientMessage.type !== "register") {
			throw new Error(`Received ${clientMessage.type} before register`);
		}

		if (DROPPED_CLIENT_MESSAGE_TYPES.has(clientMessage.type)) {
			writeMessage(socket, {
				type: "error",
				error: `E_INVALID_MESSAGE: ${clientMessage.type} is not supported by this broker (no extension bus)`,
			});
			return;
		}

		switch (clientMessage.type) {
			case "register":
				this.handleRegister(socket, clientMessage, currentKey, setKey);
				break;

			case "unregister":
				this.removeSession(currentKey!, socket);
				setKey(null);
				break;

			case "list": {
				if (typeof clientMessage.requestId !== "string") throw new Error("Invalid list message");
				const requester = this.sessions.get(currentKey!);
				if (requester?.socket !== socket) throw new Error("List session not found");
				const sessions = Array.from(this.sessions.values())
					.filter((session) => sameScope(session.scopeId, requester.scopeId))
					.map((session) => session.info);
				writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
				break;
			}

			case "send":
				this.handleSend(socket, clientMessage, currentKey!);
				break;

			case "message_receipt": {
				if (!isMessageReceipt(clientMessage.receipt)) throw new Error("Invalid message_receipt message");
				this.pruneMessageReceiptRoutes();
				const route = this.messageReceiptRoutes.get(clientMessage.receipt.messageId);
				const receiver = this.sessions.get(currentKey!);
				const sender = route ? this.sessions.get(route.from) : undefined;
				// Only the session the message was routed to may report on it.
				if (route?.to === currentKey && receiver?.socket === socket && sender) {
					writeMessage(sender.socket, { type: "message_receipt", from: receiver.info, receipt: clientMessage.receipt });
				}
				break;
			}

			case "cancel_message":
				this.handleCancelMessage(socket, clientMessage, currentKey!);
				break;

			case "cancel_ask": {
				if (typeof clientMessage.messageId !== "string") throw new Error("Invalid cancel_ask message");
				const session = this.sessions.get(currentKey!);
				const edge = this.askEdges.get(clientMessage.messageId);
				if (session?.socket === socket && edge?.from === currentKey) this.askEdges.delete(clientMessage.messageId);
				break;
			}

			case "presence":
				this.handlePresence(socket, clientMessage, currentKey!);
				break;

			default:
				throw new Error(`Unknown client message type: ${clientMessage.type}`);
		}
	}

	private handleRegister(
		socket: net.Socket,
		clientMessage: Record<string, unknown>,
		currentKey: string | null,
		setKey: (key: string | null) => void,
	): void {
		const session = clientMessage.session;
		if (!isSessionRegistration(session)) throw new Error("Invalid register message");
		if (currentKey) throw new Error("Received duplicate register message");

		let id: string = randomUUID();
		if (clientMessage.sessionId !== undefined) {
			if (!isSessionId(clientMessage.sessionId)) throw new Error("Invalid register sessionId");
			id = clientMessage.sessionId;
		}
		const scopeId = normalizeScopeId(clientMessage.scopeId);
		const key = scopedSessionKey(scopeId, id);

		this.pruneDisconnectedSessions();
		this.pruneMailboxMessages();
		const previous = this.sessions.get(key);
		if (previous) {
			// The id is not a secret (list returns every id), so handing it over
			// would let any local peer take another session's identity and mail.
			// A session that has gone is in disconnectedSessions, not here, so
			// reconnecting under a stable id still works.
			writeMessage(socket, { type: "error", error: "Session ID already held by a live session" });
			socket.destroy();
			return;
		}
		if (this.sessions.size >= MAX_SESSIONS) {
			writeMessage(socket, { type: "error", error: "Too many registered intercom sessions" });
			socket.destroy();
			return;
		}
		setKey(key);
		const info: SessionInfo = {
			id,
			endpointEpoch: randomUUID(),
			...(session.name !== undefined ? { name: session.name } : {}),
			...(session.runtimeFallbackAlias !== undefined ? { runtimeFallbackAlias: session.runtimeFallbackAlias } : {}),
			cwd: session.cwd,
			model: session.model,
			pid: session.pid,
			startedAt: session.startedAt,
			lastActivity: session.lastActivity,
			...(session.status !== undefined ? { status: session.status } : {}),
			...(session.tmuxPane !== undefined ? { tmuxPane: session.tmuxPane } : {}),
			trustedLocal: true,
		};
		const connected: ConnectedSession = {
			socket,
			info,
			key,
			...(scopeId ? { scopeId } : {}),
			lastPresenceBroadcastAt: Date.now(),
		};
		this.sessions.set(key, connected);
		this.disconnectedSessions.delete(key);
		if (this.shutdownTimer) {
			clearTimeout(this.shutdownTimer);
			this.shutdownTimer = null;
		}

		// Must be the first frame the session gets. extension-bus-v1 is not
		// advertised, which is how an upstream client learns not to use the bus.
		writeMessage(socket, { type: "registered", sessionId: id, features: [EXACT_SEND_FEATURE] });
		this.broadcast({ type: "session_joined", session: info }, key, scopeId);
		this.flushMailboxForSession(connected);
	}

	private handleSend(socket: net.Socket, clientMessage: Record<string, unknown>, currentKey: string): void {
		const message = clientMessage.message;
		const messageId = isMessage(message) ? message.id : "unknown";
		if (typeof clientMessage.to !== "string" || !isMessage(message)) {
			this.writeDeliveryFailure(socket, messageId, "Invalid message format", "E_INVALID_MESSAGE");
			return;
		}
		const dropped = DROPPED_MESSAGE_FIELDS.find((field) => (message as unknown as Record<string, unknown>)[field] !== undefined);
		if (dropped) {
			this.writeDeliveryFailure(socket, message.id, `Message field "${dropped}" is not supported by this broker`, "E_INVALID_MESSAGE");
			return;
		}
		const fromSession = this.sessions.get(currentKey);
		if (fromSession?.socket !== socket) {
			this.writeDeliveryFailure(socket, message.id, "Sender session not found", "E_SENDER_NOT_FOUND");
			return;
		}

		const brokerReceivedAt = Date.now();
		this.pruneAskEdges(brokerReceivedAt);
		this.pruneMessageReceiptRoutes(brokerReceivedAt);
		const replyEdge = message.replyTo ? this.askEdges.get(message.replyTo) : undefined;
		let to = clientMessage.to;

		// Exact send: the client resolved the target to an id and endpoint epoch
		// from a fresh list, so a session that re-registered in between (same id,
		// new epoch) is reported as rebound rather than silently receiving a
		// message meant for its predecessor.
		const hasTargetId = clientMessage.targetId !== undefined;
		const hasTargetEpoch = clientMessage.targetEpoch !== undefined;
		if (
			hasTargetId !== hasTargetEpoch ||
			(hasTargetId && (typeof clientMessage.targetId !== "string" || clientMessage.targetId.length === 0)) ||
			(hasTargetEpoch && (typeof clientMessage.targetEpoch !== "string" || clientMessage.targetEpoch.length === 0))
		) {
			this.writeDeliveryFailure(socket, message.id, "Exact target requires an id and endpoint epoch", "E_INVALID_TARGET");
			return;
		}
		if (hasTargetId && hasTargetEpoch) {
			const targetId = clientMessage.targetId as string;
			const targetEpoch = clientMessage.targetEpoch as string;
			const fingerprint = messageDeliveryFingerprint(message, targetId);
			if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) return;
			const exactTarget = this.sessions.get(scopedSessionKey(fromSession.scopeId, targetId));
			if (!exactTarget) {
				this.recordDelivery(currentKey, message.id, fingerprint, "failed", "Session not found", "E_TARGET_NOT_FOUND");
				this.writeDeliveryFailure(socket, message.id, "Session not found", "E_TARGET_NOT_FOUND");
				return;
			}
			if (exactTarget.info.endpointEpoch !== targetEpoch) {
				this.recordDelivery(currentKey, message.id, fingerprint, "failed", "Target endpoint changed before delivery", "E_TARGET_REBOUND", true);
				this.writeDeliveryFailure(socket, message.id, "Target endpoint changed before delivery", "E_TARGET_REBOUND", true);
				return;
			}
			to = targetId;
		}

		const targets = this.findSessions(to, fromSession.scopeId);
		if (targets.length === 1) {
			if (message.replyTo && !replyEdge) {
				this.writeDeliveryFailure(socket, message.id, "Reply target does not match a pending ask", "E_REPLY_TARGET");
				return;
			}
			const target = targets[0]!;
			const fingerprint = messageDeliveryFingerprint(message, target.info.id);
			if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) return;
			if (message.supersedes) {
				const supersededRoute = this.messageReceiptRoutes.get(message.supersedes);
				if (!supersededRoute || supersededRoute.from !== currentKey || supersededRoute.to !== target.key) {
					this.writeDeliveryFailure(
						socket,
						message.id,
						"Supersede target does not match a previous message from this sender to this receiver",
						"E_SUPERSEDE_TARGET",
					);
					return;
				}
			}
			if (replyEdge && (replyEdge.to !== currentKey || replyEdge.from !== target.key)) {
				this.writeDeliveryFailure(socket, message.id, "Reply target does not match the pending ask", "E_REPLY_TARGET");
				return;
			}
			if (message.expectsReply) {
				// Two sessions each waiting on the other would both sit out the
				// full ask timeout.
				const reverseEdge = Array.from(this.askEdges.entries()).find(
					([edgeMessageId, edge]) => edgeMessageId !== message.replyTo && edge.from === target.key && edge.to === currentKey,
				);
				if (reverseEdge) {
					this.writeDeliveryFailure(
						socket,
						message.id,
						"Mutual ask refused: target session is already waiting for a reply from this session.",
						"E_MUTUAL_ASK",
					);
					return;
				}
				this.askEdges.set(message.id, { from: currentKey, to: target.key, createdAt: brokerReceivedAt });
			}
			if (message.supersedes) {
				const control: MessageControl = {
					action: "supersede",
					messageId: message.supersedes,
					supersededBy: message.id,
					timestamp: Date.now(),
				};
				writeMessage(target.socket, { type: "message_control", from: fromSession.info, control });
				this.updateDeliveryRecord(currentKey, message.supersedes, "failed", `Superseded by ${message.id}`, "E_DELIVERY_SUPERSEDED");
			}
			writeMessage(target.socket, {
				type: "message",
				from: fromSession.info,
				message: { ...message, brokerReceivedAt, brokerDeliveredAt: Date.now() },
			});
			if (message.replyTo) this.askEdges.delete(message.replyTo);
			this.messageReceiptRoutes.set(message.id, { from: currentKey, to: target.key, createdAt: brokerReceivedAt });
			this.recordDelivery(currentKey, message.id, fingerprint, "socket_delivered");
			this.writeDeliverySuccess(socket, message.id, "socket_delivered");
			return;
		}

		if (targets.length > 1) {
			this.writeDeliveryFailure(socket, message.id, `Multiple sessions named "${to}" are connected. Use the session ID instead.`, "E_AMBIGUOUS_TARGET");
			return;
		}

		const disconnectedTargets = this.findDisconnectedSessions(to, fromSession.scopeId);
		if (disconnectedTargets.length === 1) {
			if (message.replyTo && !replyEdge) {
				this.writeDeliveryFailure(socket, message.id, "Reply target does not match a pending ask", "E_REPLY_TARGET");
				return;
			}
			const disconnectedTarget = disconnectedTargets[0]!;
			const fingerprint = messageDeliveryFingerprint(message, disconnectedTarget.info.id);
			if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) return;
			if (message.supersedes) {
				this.writeDeliveryFailure(socket, message.id, "Supersede target is not connected", "E_SUPERSEDE_TARGET");
				return;
			}
			if (replyEdge && (replyEdge.to !== currentKey || replyEdge.from !== disconnectedTarget.key)) {
				this.writeDeliveryFailure(socket, message.id, "Reply target does not match the pending ask", "E_REPLY_TARGET");
				return;
			}
			if (message.expectsReply) {
				this.writeDeliveryFailure(
					socket,
					message.id,
					"Target session is not currently connected; blocking asks are not queued",
					"E_TARGET_DISCONNECTED",
				);
				return;
			}
			const liveMailboxTarget = this.findUniqueLiveSessionForDisconnectedSession(disconnectedTarget, currentKey);
			if (liveMailboxTarget) {
				writeMessage(liveMailboxTarget.socket, {
					type: "message",
					from: fromSession.info,
					message: { ...message, brokerReceivedAt, brokerDeliveredAt: Date.now() },
				});
				this.messageReceiptRoutes.set(message.id, { from: currentKey, to: liveMailboxTarget.key, createdAt: brokerReceivedAt });
			} else {
				this.queueMailboxMessage(fromSession, disconnectedTarget, message, brokerReceivedAt);
			}
			if (message.replyTo) this.askEdges.delete(message.replyTo);
			const state = liveMailboxTarget ? "socket_delivered" : "queued";
			this.recordDelivery(currentKey, message.id, fingerprint, state);
			this.writeDeliverySuccess(socket, message.id, state);
			return;
		}

		if (disconnectedTargets.length > 1) {
			this.writeDeliveryFailure(
				socket,
				message.id,
				`Multiple disconnected sessions named "${to}" can receive queued mail. Use the session ID instead.`,
				"E_AMBIGUOUS_TARGET",
			);
			return;
		}

		this.writeDeliveryFailure(socket, message.id, "Session not found", "E_TARGET_NOT_FOUND");
	}

	private handleCancelMessage(socket: net.Socket, clientMessage: Record<string, unknown>, currentKey: string): void {
		const messageId = clientMessage.messageId;
		if (typeof messageId !== "string") throw new Error("Invalid cancel_message message");
		this.pruneMessageReceiptRoutes();
		this.pruneMailboxMessages();
		const sender = this.sessions.get(currentKey);
		const queuedIndex = this.mailboxMessages.findIndex((entry) => entry.message.id === messageId && entry.fromKey === currentKey);
		if (queuedIndex >= 0 && sender?.socket === socket) {
			this.mailboxMessages.splice(queuedIndex, 1);
			this.updateDeliveryRecord(currentKey, messageId, "failed", "Sender cancelled the queued delivery", "E_DELIVERY_CANCELLED");
			if (this.askEdges.get(messageId)?.from === currentKey) this.askEdges.delete(messageId);
			writeMessage(socket, { type: "delivered", messageId });
			return;
		}
		const route = this.messageReceiptRoutes.get(messageId);
		const receiver = route ? this.sessions.get(route.to) : undefined;
		if (route?.from !== currentKey || sender?.socket !== socket || !receiver) {
			writeMessage(socket, { type: "delivery_failed", messageId, reason: "Message cannot be cancelled by this session" });
			return;
		}
		writeMessage(receiver.socket, {
			type: "message_control",
			from: sender.info,
			control: { action: "cancel", messageId, timestamp: Date.now() },
		});
		if (this.askEdges.get(messageId)?.from === currentKey) this.askEdges.delete(messageId);
		this.updateDeliveryRecord(currentKey, messageId, "failed", "Sender cancelled the delivery", "E_DELIVERY_CANCELLED");
		writeMessage(socket, { type: "delivered", messageId });
	}

	private handlePresence(socket: net.Socket, clientMessage: Record<string, unknown>, currentKey: string): void {
		const session = this.sessions.get(currentKey);
		if (session?.socket !== socket) return;
		const info = session.info;
		let changed = false;

		for (const field of ["name", "status", "model"] as const) {
			const value = clientMessage[field];
			if (value === undefined) continue;
			if (typeof value !== "string") throw new Error(`Invalid presence ${field}`);
			if (info[field] !== value) {
				info[field] = value;
				changed = true;
			}
		}
		if (clientMessage.runtimeFallbackAlias !== undefined) {
			if (typeof clientMessage.runtimeFallbackAlias !== "boolean") throw new Error("Invalid presence runtimeFallbackAlias");
			if (info.runtimeFallbackAlias !== clientMessage.runtimeFallbackAlias) {
				info.runtimeFallbackAlias = clientMessage.runtimeFallbackAlias;
				changed = true;
			}
		}
		// A number updates, an explicit null clears (usage is unknown right after
		// a compaction, so the stale high value must not carry forward), and
		// undefined leaves the field alone.
		for (const field of ["contextPct", "contextTokens", "contextWindow"] as const) {
			const value = clientMessage[field];
			if (value === undefined) continue;
			if (value === null) {
				if (info[field] !== undefined) {
					delete info[field];
					changed = true;
				}
			} else if (typeof value !== "number") {
				throw new Error(`Invalid presence ${field}`);
			} else if (info[field] !== value) {
				info[field] = value;
				changed = true;
			}
		}

		const now = Date.now();
		info.lastActivity = now;
		if (changed || now - session.lastPresenceBroadcastAt >= PRESENCE_HEARTBEAT_MS) {
			session.lastPresenceBroadcastAt = now;
			this.broadcast({ type: "presence_update", session: info }, currentKey, session.scopeId);
		}
	}

	private rememberDisconnectedSession(session: ConnectedSession, now = Date.now()): void {
		this.disconnectedSessions.set(session.key, {
			info: { ...session.info },
			key: session.key,
			...(session.scopeId ? { scopeId: session.scopeId } : {}),
			disconnectedAt: now,
		});
		this.pruneDisconnectedSessions(now);
	}

	private pruneDisconnectedSessions(now = Date.now()): void {
		for (const [key, session] of this.disconnectedSessions) {
			if (now - session.disconnectedAt > DISCONNECTED_SESSION_RETENTION_MS) this.disconnectedSessions.delete(key);
		}
	}

	private pruneMailboxMessages(now = Date.now()): void {
		for (let index = this.mailboxMessages.length - 1; index >= 0; index -= 1) {
			const entry = this.mailboxMessages[index]!;
			if (now - entry.queuedAt > MAILBOX_MESSAGE_RETENTION_MS) {
				if (entry.message.expectsReply) this.askEdges.delete(entry.message.id);
				this.messageReceiptRoutes.delete(entry.message.id);
				this.updateDeliveryRecord(entry.fromKey, entry.message.id, "failed", "Mailbox delivery expired", "E_DELIVERY_EXPIRED");
				this.mailboxMessages.splice(index, 1);
			}
		}
	}

	private queueMailboxMessage(from: ConnectedSession, target: DisconnectedSession, message: Message, brokerReceivedAt: number): void {
		this.pruneMailboxMessages(brokerReceivedAt);
		while (this.mailboxMessages.length >= MAX_MAILBOX_MESSAGES) {
			const evicted = this.mailboxMessages.shift();
			if (!evicted) break;
			if (evicted.message.expectsReply) this.askEdges.delete(evicted.message.id);
			this.messageReceiptRoutes.delete(evicted.message.id);
			this.updateDeliveryRecord(evicted.fromKey, evicted.message.id, "failed", "Mailbox capacity evicted the delivery", "E_DELIVERY_EVICTED");
		}
		this.mailboxMessages.push({
			from: { ...from.info },
			fromKey: from.key,
			...(from.scopeId ? { fromScopeId: from.scopeId } : {}),
			target: { ...target.info },
			targetKey: target.key,
			...(target.scopeId ? { targetScopeId: target.scopeId } : {}),
			message: { ...message, brokerReceivedAt },
			queuedAt: brokerReceivedAt,
		});
	}

	private writeDeliverySuccess(socket: net.Socket, messageId: string, delivery: "socket_delivered" | "queued"): void {
		writeMessage(socket, { type: "delivered", messageId, delivery, retryable: false, outcomeKnown: true });
	}

	private writeDeliveryFailure(socket: net.Socket, messageId: string, reason: string, code: string, retryable = false): void {
		writeMessage(socket, { type: "delivery_failed", messageId, reason, delivery: "failed", code, retryable, outcomeKnown: true });
	}

	private deliveryRecordKey(fromKey: string, messageId: string): string {
		return JSON.stringify([fromKey, messageId]);
	}

	/**
	 * Replay guard. A client that retries a send after a timeout must not
	 * deliver twice: the same sender and message id with the same content gets
	 * the earlier outcome back, and different content under a reused id is
	 * refused. A rebound is the exception, since the client retries it on
	 * purpose against the new endpoint.
	 */
	private replayOrReject(socket: net.Socket, fromKey: string, messageId: string, fingerprint: string): boolean {
		this.pruneDeliveryRecords();
		const record = this.deliveryRecords.get(this.deliveryRecordKey(fromKey, messageId));
		if (!record) return false;
		if (record.fingerprint !== fingerprint) {
			this.writeDeliveryFailure(socket, messageId, "Message id was reused with different authored content", "E_MESSAGE_ID_REUSE");
			return true;
		}
		if (record.code === "E_TARGET_REBOUND" && record.retryable) return false;
		if (record.state === "socket_delivered" || record.state === "queued") {
			this.writeDeliverySuccess(socket, messageId, record.state);
		} else {
			this.writeDeliveryFailure(socket, messageId, record.reason ?? "Previous delivery failed", record.code ?? "E_DELIVERY_FAILED", record.retryable);
		}
		return true;
	}

	private recordDelivery(
		fromKey: string,
		messageId: string,
		fingerprint: string,
		state: DeliveryState,
		reason?: string,
		code?: string,
		retryable = false,
	): void {
		this.pruneDeliveryRecords();
		while (this.deliveryRecords.size >= MAX_DELIVERY_RECORDS) {
			const oldest = this.deliveryRecords.keys().next().value;
			if (oldest === undefined) break;
			this.deliveryRecords.delete(oldest);
		}
		this.deliveryRecords.set(this.deliveryRecordKey(fromKey, messageId), {
			fingerprint,
			state,
			...(reason ? { reason } : {}),
			...(code ? { code } : {}),
			retryable,
			outcomeKnown: true,
			createdAt: Date.now(),
		});
	}

	private pruneDeliveryRecords(now = Date.now()): void {
		for (const [key, record] of this.deliveryRecords) {
			if (now - record.createdAt > DELIVERY_RECORD_RETENTION_MS) this.deliveryRecords.delete(key);
		}
	}

	private updateDeliveryRecord(fromKey: string, messageId: string, state: DeliveryState, reason?: string, code?: string): void {
		const record = this.deliveryRecords.get(this.deliveryRecordKey(fromKey, messageId));
		if (!record) return;
		record.state = state;
		record.reason = reason;
		record.code = code;
		record.retryable = false;
		record.outcomeKnown = true;
	}

	private flushMailboxForSession(session: ConnectedSession): void {
		this.pruneMailboxMessages();
		const sessionName = session.info.name?.toLowerCase();
		const uniqueMailboxIdentity = this.findLiveSessionsSharingMailboxIdentity(session).length === 1;

		for (let index = 0; index < this.mailboxMessages.length; ) {
			const entry = this.mailboxMessages[index]!;
			if (!sameScope(entry.targetScopeId, session.scopeId)) {
				index += 1;
				continue;
			}
			const matchesId = entry.targetKey === session.key;
			// Mail this session itself sent under the same name and cwd must not
			// bounce back to it as if addressed to it.
			const matchesSenderIdentity = Boolean(
				sessionName &&
					sameScope(entry.fromScopeId, session.scopeId) &&
					entry.from.name?.toLowerCase() === sessionName &&
					sameCwd(entry.from.cwd, session.info.cwd),
			);
			const matchesUniqueName = Boolean(
				uniqueMailboxIdentity &&
					sessionName &&
					!matchesSenderIdentity &&
					entry.target.name?.toLowerCase() === sessionName &&
					sameCwd(entry.target.cwd, session.info.cwd),
			);
			if (!matchesId && !matchesUniqueName) {
				index += 1;
				continue;
			}

			this.mailboxMessages.splice(index, 1);
			writeMessage(session.socket, {
				type: "message",
				from: entry.from,
				message: { ...entry.message, brokerDeliveredAt: Date.now() },
			});
			this.messageReceiptRoutes.set(entry.message.id, {
				from: entry.fromKey,
				to: session.key,
				createdAt: entry.message.brokerReceivedAt ?? entry.queuedAt,
			});
			this.updateDeliveryRecord(entry.fromKey, entry.message.id, "socket_delivered");
		}
	}

	private pruneAskEdges(now = Date.now()): void {
		for (const [messageId, edge] of this.askEdges) {
			if (now - edge.createdAt > this.askTimeoutMs) this.askEdges.delete(messageId);
		}
	}

	// Only the asks this session made: its waiter died with it, so nothing can
	// receive their answers. Asks made of it stay, so a target that drops and
	// reconnects mid-ask can still answer the asker who is still waiting.
	private clearAskEdgesForSession(sessionKey: string): void {
		for (const [messageId, edge] of this.askEdges) {
			if (edge.from === sessionKey) this.askEdges.delete(messageId);
		}
	}

	private pruneMessageReceiptRoutes(now = Date.now()): void {
		for (const [messageId, route] of this.messageReceiptRoutes) {
			if (now - route.createdAt > MESSAGE_RECEIPT_ROUTE_RETENTION_MS) this.messageReceiptRoutes.delete(messageId);
		}
	}

	private clearMessageReceiptRoutesForSession(sessionKey: string): void {
		for (const [messageId, route] of this.messageReceiptRoutes) {
			if (route.from === sessionKey || route.to === sessionKey) this.messageReceiptRoutes.delete(messageId);
		}
	}

	/** Exact id, then case-insensitive name, then unique id prefix; all within the scope. */
	private findSessions(nameOrId: string, scopeId: string | undefined): ConnectedSession[] {
		return this.resolveTarget(this.sessions, nameOrId, scopeId);
	}

	private findDisconnectedSessions(nameOrId: string, scopeId: string | undefined): DisconnectedSession[] {
		this.pruneDisconnectedSessions();
		return this.resolveTarget(this.disconnectedSessions, nameOrId, scopeId);
	}

	private resolveTarget<T extends { info: SessionInfo; scopeId?: string }>(
		pool: Map<string, T>,
		nameOrId: string,
		scopeId: string | undefined,
	): T[] {
		const byId = pool.get(scopedSessionKey(scopeId, nameOrId));
		if (byId) return [byId];
		const inScope = Array.from(pool.values()).filter((session) => sameScope(session.scopeId, scopeId));
		const lowerName = nameOrId.toLowerCase();
		const byName = inScope.filter((session) => session.info.name?.toLowerCase() === lowerName);
		if (byName.length > 0) return byName;
		return inScope.filter((session) => session.info.id.startsWith(nameOrId));
	}

	private findUniqueLiveSessionForDisconnectedSession(disconnected: DisconnectedSession, senderKey: string): ConnectedSession | null {
		const matches = this.findLiveSessionsSharingMailboxIdentity(disconnected).filter((session) => session.key !== senderKey);
		return matches.length === 1 ? matches[0]! : null;
	}

	/**
	 * Mailbox identity is an explicit name plus directory, never a name alone,
	 * so queued mail cannot cross projects. A runtime fallback alias is derived
	 * from the session id rather than chosen, so it never carries mail to
	 * another process; that also keeps two unnamed sessions started close
	 * together from sharing a mailbox through a common alias prefix.
	 */
	private findLiveSessionsSharingMailboxIdentity(session: ConnectedSession | DisconnectedSession): ConnectedSession[] {
		const lowerName = session.info.name?.toLowerCase();
		if (!lowerName || session.info.runtimeFallbackAlias) return [];
		return Array.from(this.sessions.values()).filter(
			(live) =>
				sameScope(live.scopeId, session.scopeId) &&
				!live.info.runtimeFallbackAlias &&
				live.info.name?.toLowerCase() === lowerName &&
				sameCwd(live.info.cwd, session.info.cwd),
		);
	}

	private broadcast(msg: BrokerMessage, exclude?: string, scopeId?: string): void {
		for (const [key, session] of this.sessions) {
			if (key !== exclude && sameScope(session.scopeId, scopeId)) writeMessage(session.socket, msg);
		}
	}

	private shutdown(): void {
		console.log("Broker shutting down");
		for (const session of this.sessions.values()) session.socket.end();
		this.sessions.clear();
		try {
			unlinkSync(SOCKET_PATH);
		} catch {
			// Already gone.
		}
		try {
			unlinkSync(PID_PATH);
		} catch {
			// Startup may not have got as far as writing it.
		}
		this.server.close();
		process.exit(0);
	}
}

new IntercomBroker().start();
