// Shape checks for every frame that crosses the broker socket, and the ask
// timeout both ends agree on. Ported from pi-intercom 0.16.1's
// broker/protocol.ts and config.ts (MIT, Nico Bailon).
//
// Both sides validate what they receive instead of trusting the peer: the
// broker serves every local process of this user, and the client must not act
// on a malformed frame from a broker of another version.

import type {
	Attachment,
	Message,
	MessageControl,
	MessageReceipt,
	MessageReceiptStatus,
	SessionInfo,
	SessionRegistration,
} from "./types.ts";

const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long an ask may wait for its reply. The broker keeps the ask edge this
 * long and the asker waits this long; pi-subagents reads the same variable.
 */
export function getAskTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_INTERCOM_ASK_TIMEOUT_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_ASK_TIMEOUT_MS;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("PI_INTERCOM_ASK_TIMEOUT_MS must be a positive integer number of milliseconds");
	}
	return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const optional = (value: unknown, type: "string" | "number" | "boolean") =>
	value === undefined || typeof value === type;

function isMessageReceiptStatus(value: unknown): value is MessageReceiptStatus {
	return (
		value === "receiver_received" ||
		value === "queued" ||
		value === "injected" ||
		value === "acknowledged" ||
		value === "expired" ||
		value === "cancelled" ||
		value === "superseded" ||
		value === "cancellation_requested"
	);
}

export function isMessageReceipt(value: unknown): value is MessageReceipt {
	if (!isRecord(value)) return false;
	return (
		typeof value.messageId === "string" &&
		isMessageReceiptStatus(value.status) &&
		typeof value.timestamp === "number" &&
		optional(value.detail, "string")
	);
}

export function isMessageControl(value: unknown): value is MessageControl {
	if (!isRecord(value)) return false;
	return (
		typeof value.messageId === "string" &&
		typeof value.timestamp === "number" &&
		(value.action === "cancel" || value.action === "supersede") &&
		optional(value.supersededBy, "string") &&
		optional(value.detail, "string")
	);
}

function isAttachment(value: unknown): value is Attachment {
	if (!isRecord(value)) return false;
	return (
		(value.type === "file" || value.type === "snippet" || value.type === "context") &&
		typeof value.name === "string" &&
		typeof value.content === "string" &&
		optional(value.language, "string")
	);
}

/**
 * Fields an upstream pi-intercom peer may put on a message for features this
 * port dropped: extension-outbox provenance and cross-machine relay origin.
 * The broker refuses such sends; the client strips them from what it receives
 * so the extension never treats a peer-asserted origin as meaningful.
 */
export const DROPPED_MESSAGE_FIELDS = ["provenance", "crossMachine"] as const;

export function isMessage(value: unknown): value is Message {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || typeof value.timestamp !== "number") return false;
	for (const key of ["senderSequence", "brokerReceivedAt", "brokerDeliveredAt", "receiverReceivedAt", "injectedAt"] as const) {
		if (!optional(value[key], "number")) return false;
	}
	for (const key of ["supersedes", "retryOf", "replyTo"] as const) {
		if (!optional(value[key], "string")) return false;
	}
	if (!optional(value.expectsReply, "boolean")) return false;
	if (!isRecord(value.content) || typeof value.content.text !== "string") return false;
	return (
		value.content.attachments === undefined ||
		(Array.isArray(value.content.attachments) && value.content.attachments.every(isAttachment))
	);
}

/** Canonical authored-message identity used by the broker's replay guard. */
export function messageDeliveryFingerprint(message: Message, targetId: string): string {
	return JSON.stringify({
		targetId,
		text: message.content.text,
		attachments: message.content.attachments,
		replyTo: message.replyTo,
		expectsReply: message.expectsReply,
		supersedes: message.supersedes,
		retryOf: message.retryOf,
	});
}

export function isSessionInfo(value: unknown): value is SessionInfo {
	if (!isRecord(value)) return false;
	if (
		typeof value.id !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.model !== "string" ||
		typeof value.pid !== "number" ||
		typeof value.startedAt !== "number" ||
		typeof value.lastActivity !== "number"
	) {
		return false;
	}
	return (
		optional(value.endpointEpoch, "string") &&
		optional(value.name, "string") &&
		optional(value.runtimeFallbackAlias, "boolean") &&
		optional(value.status, "string") &&
		optional(value.contextPct, "number") &&
		optional(value.contextTokens, "number") &&
		optional(value.contextWindow, "number") &&
		optional(value.tmuxPane, "string") &&
		optional(value.trustedLocal, "boolean")
	);
}

export function isSessionId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function isSessionRegistration(value: unknown): value is SessionRegistration {
	if (!isRecord(value)) return false;
	if (
		typeof value.cwd !== "string" ||
		typeof value.model !== "string" ||
		typeof value.pid !== "number" ||
		typeof value.startedAt !== "number" ||
		typeof value.lastActivity !== "number"
	) {
		return false;
	}
	return (
		optional(value.name, "string") &&
		optional(value.runtimeFallbackAlias, "boolean") &&
		optional(value.status, "string") &&
		optional(value.tmuxPane, "string")
	);
}
