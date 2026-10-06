// Wire types for the pi↔pi broker, a trimmed copy of pi-intercom 0.16.1's
// types.ts (MIT, Nico Bailon; see LICENSE here).
//
// Field names, message type strings and feature names are kept exactly so this
// broker and client interoperate with pi-intercom's protocol "pi-intercom"
// version 1. What is gone is what this setup dropped: the extension bus,
// extension-outbox provenance, cross-machine relays and Herdr locations. A peer
// that still sends those gets an explicit rejection from the broker rather
// than a silent half-delivery.

export const EXACT_SEND_FEATURE = "exact-send-v1";

export type DeliveryState = "socket_delivered" | "queued" | "failed" | "unknown";

export interface DeliveryDetails {
	delivery: DeliveryState;
	code?: string;
	retryable: boolean;
	outcomeKnown: boolean;
}

export interface SessionInfo {
	id: string;
	/** Broker-owned lifetime of this live endpoint; a fresh UUID per registration. */
	endpointEpoch?: string;
	name?: string;
	/** True only when the extension synthesized the name for an unnamed session. */
	runtimeFallbackAlias?: boolean;
	cwd: string;
	model: string;
	pid: number;
	startedAt: number;
	lastActivity: number;
	status?: string;
	trustedLocal?: boolean;
	/** Context-window usage pushed through presence. Absent when unknown, for
	 *  example right after a compaction. contextPct is 0..100. */
	contextPct?: number;
	contextTokens?: number;
	contextWindow?: number;
	/** $TMUX_PANE at registration, when the session runs inside tmux. */
	tmuxPane?: string;
}

export interface Attachment {
	type: "file" | "snippet" | "context";
	name: string;
	content: string;
	language?: string;
}

export interface Message {
	id: string;
	timestamp: number;
	senderSequence?: number;
	brokerReceivedAt?: number;
	brokerDeliveredAt?: number;
	receiverReceivedAt?: number;
	injectedAt?: number;
	supersedes?: string;
	retryOf?: string;
	replyTo?: string;
	expectsReply?: boolean;
	content: {
		text: string;
		attachments?: Attachment[];
	};
}

export type MessageReceiptStatus =
	| "receiver_received"
	| "queued"
	| "injected"
	| "acknowledged"
	| "expired"
	| "cancelled"
	| "superseded"
	| "cancellation_requested";

export interface MessageReceipt {
	messageId: string;
	status: MessageReceiptStatus;
	timestamp: number;
	detail?: string;
}

export type MessageControlAction = "cancel" | "supersede";

export interface MessageControl {
	messageId: string;
	action: MessageControlAction;
	timestamp: number;
	supersededBy?: string;
	detail?: string;
}

export type SessionRegistration = Omit<SessionInfo, "id" | "endpointEpoch" | "trustedLocal">;

export interface PresenceUpdate {
	name?: string;
	runtimeFallbackAlias?: boolean;
	status?: string;
	model?: string;
	/** A number sets the field, null clears it, undefined leaves it alone. */
	contextPct?: number | null;
	contextTokens?: number | null;
	contextWindow?: number | null;
}

export type ClientMessage =
	| { type: "health"; requestId: string }
	| { type: "register"; session: SessionRegistration; sessionId?: string; scopeId?: string }
	| { type: "unregister" }
	| { type: "list"; requestId: string }
	| { type: "send"; to: string; message: Message; targetId?: string; targetEpoch?: string }
	| { type: "message_receipt"; receipt: MessageReceipt }
	| { type: "cancel_message"; messageId: string }
	| { type: "cancel_ask"; messageId: string }
	| ({ type: "presence" } & PresenceUpdate);

export type BrokerMessage =
	| { type: "health_ok"; requestId: string; protocol: string; version: number }
	| { type: "registered"; sessionId: string; features?: string[] }
	| { type: "sessions"; requestId: string; sessions: SessionInfo[] }
	| { type: "message"; from: SessionInfo; message: Message }
	| { type: "presence_update"; session: SessionInfo }
	| { type: "session_joined"; session: SessionInfo }
	| { type: "session_left"; sessionId: string }
	| { type: "error"; error: string }
	// A cancel_message acknowledgement carries only the id, as upstream does.
	| ({ type: "delivered"; messageId: string } & Partial<DeliveryDetails>)
	| ({ type: "delivery_failed"; messageId: string; reason: string } & Partial<DeliveryDetails>)
	| { type: "message_receipt"; from: SessionInfo; receipt: MessageReceipt }
	| { type: "message_control"; from: SessionInfo; control: MessageControl };
