// A pi session's connection to the broker. Ported from pi-intercom 0.16.1's
// broker/client.ts (MIT, Nico Bailon); method and event names are upstream's so
// the extension can follow upstream index.ts.
//
// Events:
//   message(from: SessionInfo, message: Message)
//   message_receipt(from: SessionInfo, receipt: MessageReceipt)
//   message_control(from: SessionInfo, control: MessageControl)
//   session_joined(session: SessionInfo), session_left(sessionId: string),
//   presence_update(session: SessionInfo)
//   broker_message(message: BrokerMessage)  every validated roster/receipt/control frame
//   disconnected(error: Error)  a registered connection closed without disconnect()
//   error(error: Error)
//
// Two liveness guards, both from upstream bugs: a broker killed with SIGKILL
// leaves a half-open socket that never reports close, so a heartbeat lists
// sessions every 30 s and tears the socket down if that times out (#89); and a
// socket error after registration destroys the socket so "disconnected" fires
// and the extension reconnects.
//
// Not upstream: every socket keeps a no-op 'error' listener for its whole
// life. Upstream removed all of them during cleanup, so an ECONNRESET arriving
// after close was an unhandled 'error' event and crashed pi (PR #23). And
// "error" is only emitted on the client when someone listens, for the same
// reason.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerSocketPath, getIntercomScopeId } from "./paths.ts";
import { DROPPED_MESSAGE_FIELDS, isMessage, isMessageControl, isMessageReceipt, isSessionInfo } from "./protocol.ts";
import {
	type Attachment,
	type BrokerMessage,
	type DeliveryDetails,
	EXACT_SEND_FEATURE,
	type Message,
	type MessageControl,
	type MessageReceipt,
	type PresenceUpdate,
	type SessionInfo,
	type SessionRegistration,
} from "./types.ts";

export interface SendOptions {
	text: string;
	attachments?: Attachment[];
	replyTo?: string;
	expectsReply?: boolean;
	messageId?: string;
	supersedes?: string;
	retryOf?: string;
}

export interface SendResult extends DeliveryDetails {
	id: string;
	delivered: boolean;
	reason?: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 5000;
const DISCONNECT_TIMEOUT_MS = 2000;

const noop = () => {};

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function getLivenessIntervalMs(): number {
	const raw = Number.parseInt(process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function getLivenessTimeoutMs(): number {
	const raw = Number.parseInt(process.env.PI_INTERCOM_LIVENESS_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? Math.min(raw, getLivenessIntervalMs()) : 5000;
}

function isWritable(socket: net.Socket | null): socket is net.Socket {
	return Boolean(socket && !socket.destroyed && !socket.writableEnded && socket.writable);
}

export class IntercomClient extends EventEmitter {
	private socket: net.Socket | null = null;
	private _sessionId: string | null = null;
	private _features = new Set<string>();
	private pendingSends = new Map<string, { resolve: (r: SendResult) => void; reject: (e: Error) => void }>();
	private pendingLists = new Map<string, { resolve: (sessions: SessionInfo[]) => void; reject: (e: Error) => void }>();
	private nextSenderSequence = 1;
	private disconnecting = false;
	private disconnectError: Error | null = null;
	private livenessTimer: ReturnType<typeof setInterval> | null = null;
	private livenessInFlight = false;

	get sessionId(): string | null {
		return this._sessionId;
	}

	supportsFeature(feature: string): boolean {
		return this._features.has(feature);
	}

	isConnected(): boolean {
		return Boolean(this._sessionId && !this.disconnecting && isWritable(this.socket));
	}

	private emitError(error: Error): void {
		if (this.listenerCount("error") > 0) this.emit("error", error);
	}

	private failPending(error: Error): void {
		for (const pending of this.pendingSends.values()) pending.reject(error);
		this.pendingSends.clear();
		for (const pending of this.pendingLists.values()) pending.reject(error);
		this.pendingLists.clear();
	}

	private startLivenessHeartbeat(): void {
		this.stopLivenessHeartbeat();
		this.livenessTimer = setInterval(() => void this.runLivenessProbe(), getLivenessIntervalMs());
		this.livenessTimer.unref?.();
	}

	private stopLivenessHeartbeat(): void {
		if (this.livenessTimer) {
			clearInterval(this.livenessTimer);
			this.livenessTimer = null;
		}
		this.livenessInFlight = false;
	}

	private async runLivenessProbe(): Promise<void> {
		if (this.livenessInFlight || !this.isConnected()) return;
		this.livenessInFlight = true;
		try {
			await this.listSessions({ timeoutMs: getLivenessTimeoutMs() });
		} catch (error) {
			// The broker is gone but the OS never said so. Destroying the socket
			// runs onClose, which emits "disconnected" and lets the extension
			// reconnect.
			const socket = this.socket;
			if (socket && !socket.destroyed) {
				this.disconnectError = toError(error);
				socket.destroy();
			}
		} finally {
			this.livenessInFlight = false;
		}
	}

	private requireActiveSocket(): net.Socket {
		if (this.disconnecting) throw new Error("Client disconnecting");
		const socket = this.socket;
		if (!socket || !this._sessionId) throw new Error("Not connected");
		if (!isWritable(socket)) throw new Error("Client disconnected");
		return socket;
	}

	connect(session: SessionRegistration, sessionId?: string): Promise<void> {
		if (this.socket) return Promise.reject(new Error("Already connected"));

		return new Promise((resolve, reject) => {
			let socket: net.Socket;
			try {
				socket = net.connect(getBrokerSocketPath());
			} catch (error) {
				reject(toError(error));
				return;
			}
			socket.on("error", noop);
			this.socket = socket;
			this.disconnectError = null;
			let settled = false;
			let connectionEstablished = false;

			const timeout = setTimeout(() => {
				if (!this._sessionId) {
					cleanupConnectionAttempt();
					cleanupSocketListeners();
					if (this.socket === socket) this.socket = null;
					socket.destroy();
					reject(new Error("Connection timeout"));
				}
			}, CONNECT_TIMEOUT_MS);

			const onRegistered = () => {
				settled = true;
				connectionEstablished = true;
				cleanupConnectionAttempt();
				this.startLivenessHeartbeat();
				resolve();
			};

			const onError = (err: Error) => {
				settled = true;
				cleanupConnectionAttempt();
				cleanupSocketListeners();
				if (this.socket === socket) this.socket = null;
				socket.destroy();
				reject(err);
			};

			const onClose = () => {
				const wasConnecting = !settled && !this._sessionId;
				const wasDisconnecting = this.disconnecting;
				const disconnectError = this.disconnectError ?? new Error("Client disconnected");
				this.disconnecting = false;
				this.stopLivenessHeartbeat();
				cleanupConnectionAttempt();
				cleanupSocketListeners();
				this.failPending(disconnectError);
				if (this.socket === socket) this.socket = null;
				this._sessionId = null;
				this._features.clear();
				this.disconnectError = null;
				if (connectionEstablished && !wasDisconnecting) this.emit("disconnected", disconnectError);
				if (wasConnecting) reject(new Error("Connection closed before registration"));
			};

			const onSocketError = (err: Error) => {
				if (!connectionEstablished) return;
				this.disconnectError = err;
				this.emitError(err);
				// The connection is dead; without this a half-open socket could keep
				// isConnected() true.
				if (!socket.destroyed) socket.destroy();
			};

			const onReaderError = (error: Error) => {
				const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
				if (!connectionEstablished) {
					onError(protocolError);
					return;
				}
				this.disconnectError = protocolError;
				this.emitError(protocolError);
				socket.destroy();
			};

			const reader = createMessageReader((msg) => this.handleBrokerMessage(msg), onReaderError);

			const cleanupConnectionAttempt = () => {
				this.off("_registered", onRegistered);
				socket.off("error", onError);
				clearTimeout(timeout);
			};

			const cleanupSocketListeners = () => {
				socket.off("data", reader);
				socket.off("error", onSocketError);
				socket.off("close", onClose);
			};

			socket.on("data", reader);
			socket.on("error", onError);
			socket.on("close", onClose);
			socket.on("error", onSocketError);
			this.once("_registered", onRegistered);

			try {
				const scopeId = getIntercomScopeId();
				writeMessage(socket, {
					type: "register",
					session,
					...(sessionId ? { sessionId } : {}),
					...(scopeId ? { scopeId } : {}),
				});
			} catch (error) {
				cleanupConnectionAttempt();
				cleanupSocketListeners();
				if (this.socket === socket) this.socket = null;
				socket.destroy();
				reject(toError(error));
			}
		});
	}

	private handleBrokerMessage(msg: unknown): void {
		if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
			throw new Error("Invalid broker message");
		}
		const brokerMessage = msg as { type: string } & Record<string, unknown>;

		if (this._sessionId === null && brokerMessage.type !== "registered" && brokerMessage.type !== "error") {
			throw new Error(`Received ${brokerMessage.type} before registered`);
		}

		switch (brokerMessage.type) {
			case "registered": {
				if (typeof brokerMessage.sessionId !== "string") throw new Error("Invalid registered message");
				if (this._sessionId !== null) throw new Error("Received duplicate registered message");
				const features = brokerMessage.features;
				if (features !== undefined && (!Array.isArray(features) || !features.every((feature) => typeof feature === "string"))) {
					throw new Error("Invalid registered features");
				}
				this._sessionId = brokerMessage.sessionId;
				this._features = new Set((features as string[] | undefined) ?? []);
				const registered: BrokerMessage = {
					type: "registered",
					sessionId: brokerMessage.sessionId,
					...(this._features.size > 0 ? { features: [...this._features] } : {}),
				};
				this.emit("broker_message", registered);
				this.emit("_registered", registered);
				break;
			}

			case "sessions": {
				const { requestId, sessions } = brokerMessage;
				if (typeof requestId !== "string" || !Array.isArray(sessions) || !sessions.every(isSessionInfo)) {
					throw new Error("Invalid sessions message");
				}
				const pending = this.pendingLists.get(requestId);
				// A late reply after the caller timed out is harmless.
				if (!pending) return;
				this.pendingLists.delete(requestId);
				pending.resolve(sessions);
				break;
			}

			case "message": {
				const { from, message } = brokerMessage;
				if (!isSessionInfo(from) || !isMessage(message)) throw new Error("Invalid message event");
				// An upstream broker relays an upstream sender's outbox provenance
				// or cross-machine origin untouched. Both are sender-asserted and
				// nothing here acts on them, so they are not passed on.
				const clean: Record<string, unknown> = { ...message };
				for (const field of DROPPED_MESSAGE_FIELDS) delete clean[field];
				this.emit("message", from, clean as unknown as Message);
				break;
			}

			case "delivered": {
				const { messageId, delivery, retryable, outcomeKnown } = brokerMessage;
				if (
					typeof messageId !== "string" ||
					(delivery !== undefined && delivery !== "socket_delivered" && delivery !== "queued") ||
					(retryable !== undefined && typeof retryable !== "boolean") ||
					(outcomeKnown !== undefined && typeof outcomeKnown !== "boolean")
				) {
					throw new Error("Invalid delivered message");
				}
				const pending = this.pendingSends.get(messageId);
				if (!pending) return;
				this.pendingSends.delete(messageId);
				pending.resolve({
					id: messageId,
					delivered: true,
					delivery: (delivery as "socket_delivered" | "queued" | undefined) ?? "socket_delivered",
					retryable: (retryable as boolean | undefined) ?? false,
					outcomeKnown: (outcomeKnown as boolean | undefined) ?? true,
					...(typeof brokerMessage.code === "string" ? { code: brokerMessage.code } : {}),
				});
				break;
			}

			case "delivery_failed": {
				const { messageId, reason, delivery, retryable, outcomeKnown } = brokerMessage;
				if (
					typeof messageId !== "string" ||
					typeof reason !== "string" ||
					(delivery !== undefined && delivery !== "failed" && delivery !== "unknown") ||
					(retryable !== undefined && typeof retryable !== "boolean") ||
					(outcomeKnown !== undefined && typeof outcomeKnown !== "boolean")
				) {
					throw new Error("Invalid delivery_failed message");
				}
				const pending = this.pendingSends.get(messageId);
				if (!pending) return;
				this.pendingSends.delete(messageId);
				pending.resolve({
					id: messageId,
					delivered: false,
					reason,
					delivery: (delivery as "failed" | "unknown" | undefined) ?? "failed",
					retryable: (retryable as boolean | undefined) ?? false,
					outcomeKnown: (outcomeKnown as boolean | undefined) ?? true,
					...(typeof brokerMessage.code === "string" ? { code: brokerMessage.code } : {}),
				});
				break;
			}

			case "message_receipt": {
				if (!isSessionInfo(brokerMessage.from) || !isMessageReceipt(brokerMessage.receipt)) {
					throw new Error("Invalid message_receipt event");
				}
				this.emit("broker_message", brokerMessage as BrokerMessage);
				this.emit("message_receipt", brokerMessage.from, brokerMessage.receipt);
				break;
			}

			case "message_control": {
				if (!isSessionInfo(brokerMessage.from) || !isMessageControl(brokerMessage.control)) {
					throw new Error("Invalid message_control event");
				}
				this.emit("broker_message", brokerMessage as BrokerMessage);
				this.emit("message_control", brokerMessage.from, brokerMessage.control);
				break;
			}

			case "session_joined": {
				if (!isSessionInfo(brokerMessage.session)) throw new Error("Invalid session_joined message");
				this.emit("broker_message", { type: "session_joined", session: brokerMessage.session } satisfies BrokerMessage);
				this.emit("session_joined", brokerMessage.session);
				break;
			}

			case "session_left": {
				if (typeof brokerMessage.sessionId !== "string") throw new Error("Invalid session_left message");
				this.emit("broker_message", { type: "session_left", sessionId: brokerMessage.sessionId } satisfies BrokerMessage);
				this.emit("session_left", brokerMessage.sessionId);
				break;
			}

			case "presence_update": {
				if (!isSessionInfo(brokerMessage.session)) throw new Error("Invalid presence_update message");
				this.emit("broker_message", { type: "presence_update", session: brokerMessage.session } satisfies BrokerMessage);
				this.emit("presence_update", brokerMessage.session);
				break;
			}

			case "error": {
				if (typeof brokerMessage.error !== "string") throw new Error("Invalid error message");
				// Before registration an error is the broker refusing us: fail connect().
				if (this._sessionId === null) throw new Error(brokerMessage.error);
				this.emitError(new Error(brokerMessage.error));
				break;
			}

			default:
				throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
		}
	}

	async disconnect(): Promise<void> {
		const socket = this.socket;
		if (!socket) return;

		this.disconnecting = true;
		this.disconnectError = null;
		this.stopLivenessHeartbeat();
		this.failPending(new Error("Client disconnected"));

		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				socket.off("close", onClose);
				socket.off("error", onError);
				resolve();
			};
			const onClose = () => finish();
			const onError = () => socket.destroy();
			const timeout = setTimeout(() => socket.destroy(), DISCONNECT_TIMEOUT_MS);
			socket.once("close", onClose);
			socket.once("error", onError);
			try {
				writeMessage(socket, { type: "unregister" });
				socket.end();
			} catch {
				// Disconnect still finishes if the unregister write fails.
				socket.destroy();
			}
		});
	}

	listSessions(options: { timeoutMs?: number } = {}): Promise<SessionInfo[]> {
		let socket: net.Socket;
		try {
			socket = this.requireActiveSocket();
		} catch (error) {
			return Promise.reject(toError(error));
		}

		return new Promise((resolve, reject) => {
			const requestId = randomUUID();
			const timeout = setTimeout(() => {
				if (this.pendingLists.delete(requestId)) reject(new Error("List sessions timeout"));
			}, options.timeoutMs ?? LIST_TIMEOUT_MS);
			this.pendingLists.set(requestId, {
				resolve: (sessions) => {
					clearTimeout(timeout);
					resolve(sessions);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			try {
				writeMessage(socket, { type: "list", requestId });
			} catch (error) {
				clearTimeout(timeout);
				this.pendingLists.delete(requestId);
				reject(toError(error));
			}
		});
	}

	/**
	 * Sends one message. On a broker with exact-send, a non-reply send first
	 * resolves `to` against a fresh list to an id and endpoint epoch, and if the
	 * target re-registered before delivery (E_TARGET_REBOUND) resolves and
	 * sends once more under the same message id. Replies skip this: the broker
	 * routes them by the ask edge.
	 */
	async send(to: string, options: SendOptions): Promise<SendResult> {
		const socket = this.requireActiveSocket();
		const messageId = options.messageId ?? randomUUID();
		const message: Message = {
			id: messageId,
			timestamp: Date.now(),
			senderSequence: this.nextSenderSequence++,
			supersedes: options.supersedes,
			retryOf: options.retryOf,
			replyTo: options.replyTo,
			expectsReply: options.expectsReply,
			content: { text: options.text, attachments: options.attachments },
		};

		const sendOnce = (targetId?: string, targetEpoch?: string): Promise<SendResult> =>
			this.request(messageId, "Send timeout", () =>
				writeMessage(socket, { type: "send", to, message, ...(targetId && targetEpoch ? { targetId, targetEpoch } : {}) }),
			);

		if (!this.supportsFeature(EXACT_SEND_FEATURE) || options.replyTo) return sendOnce();

		const resolveTarget = async (): Promise<{ id: string; epoch: string } | null> => {
			const sessions = await this.listSessions();
			const byId = sessions.find((session) => session.id === to);
			const byName = byId ? [] : sessions.filter((session) => session.name?.toLowerCase() === to.toLowerCase());
			const byPrefix = byId || byName.length > 0 ? [] : sessions.filter((session) => session.id.startsWith(to));
			const matches = byId ? [byId] : byName.length > 0 ? byName : byPrefix;
			const target = matches.length === 1 ? matches[0]! : null;
			return target?.endpointEpoch ? { id: target.id, epoch: target.endpointEpoch } : null;
		};

		// No unique live match: let the broker resolve it, which also covers
		// queued mail to a disconnected session and its ambiguity errors.
		const target = await resolveTarget();
		if (!target) return sendOnce();
		const result = await sendOnce(target.id, target.epoch);
		if (result.code !== "E_TARGET_REBOUND") return result;
		const reboundTarget = await resolveTarget();
		return reboundTarget ? sendOnce(reboundTarget.id, reboundTarget.epoch) : result;
	}

	cancelMessage(messageId: string): Promise<SendResult> {
		let socket: net.Socket;
		try {
			socket = this.requireActiveSocket();
		} catch (error) {
			return Promise.reject(toError(error));
		}
		return this.request(messageId, "Cancel timeout", () => writeMessage(socket, { type: "cancel_message", messageId }));
	}

	/** Waits for the delivered/delivery_failed frame answering messageId. */
	private request(messageId: string, timeoutMessage: string, write: () => void): Promise<SendResult> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.pendingSends.delete(messageId)) reject(new Error(timeoutMessage));
			}, SEND_TIMEOUT_MS);
			this.pendingSends.set(messageId, {
				resolve: (result) => {
					clearTimeout(timeout);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			try {
				write();
			} catch (error) {
				clearTimeout(timeout);
				this.pendingSends.delete(messageId);
				reject(toError(error));
			}
		});
	}

	sendMessageReceipt(receipt: MessageReceipt): void {
		if (this.disconnecting || !this._sessionId || !isWritable(this.socket)) return;
		writeMessage(this.socket, { type: "message_receipt", receipt });
	}

	cancelAsk(messageId: string): void {
		if (this.disconnecting || !this._sessionId || !isWritable(this.socket)) return;
		try {
			writeMessage(this.socket, { type: "cancel_ask", messageId });
		} catch {
			// Best-effort; the caller's local waiter cleanup must still proceed.
		}
	}

	updatePresence(updates: PresenceUpdate): void {
		if (this.disconnecting || !this._sessionId || !isWritable(this.socket)) return;
		writeMessage(this.socket, { type: "presence", ...updates });
	}

	onBrokerMessage(handler: (message: BrokerMessage) => void): () => void {
		this.on("broker_message", handler);
		return () => this.off("broker_message", handler);
	}

	onMessageReceipt(handler: (from: SessionInfo, receipt: MessageReceipt) => void): () => void {
		this.on("message_receipt", handler);
		return () => this.off("message_receipt", handler);
	}

	onMessageControl(handler: (from: SessionInfo, control: MessageControl) => void): () => void {
		this.on("message_control", handler);
		return () => this.off("message_control", handler);
	}
}
