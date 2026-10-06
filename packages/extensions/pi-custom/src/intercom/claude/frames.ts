// The wire format of Claude Code's peer sockets: newline-delimited JSON, one
// connection per message, an optional auth line first. Pure: line splitting,
// frame building and reading inbound frames into what the transport acts on.
//
// Inbound, only two frame kinds matter. A "user" frame is a message; a
// peer_message_status control frame is a receipt for something we sent.
// Everything else Claude can send (rename, notify_when_idle, idle notices,
// artifact hand-offs) is ignored: rename is unauthenticated and the name is the
// user's to set, and we advertise none of the features the rest belong to.

import { type FromMode, parseEnvelope } from "./envelope.ts";

/** Longest line, and largest send, Claude accepts. */
export const MAX_LINE = 1024 * 1024;

export type Priority = "now" | "next" | "later";
export type ReceiptStatus = "held" | "denied" | "expired" | "delivered" | "refused" | "dropped";

const PRIORITIES: readonly Priority[] = ["now", "next", "later"];
const STATUSES: readonly ReceiptStatus[] = ["held", "denied", "expired", "delivered", "refused", "dropped"];

/**
 * Splits a byte stream into lines. A line longer than MAX_LINE overflows, and
 * the connection carrying it should be dropped rather than buffered further.
 */
export class LineBuffer {
	private pending = "";

	constructor(private readonly max = MAX_LINE) {}

	push(chunk: string): { lines: string[]; overflow: boolean } {
		this.pending += chunk;
		const parts = this.pending.split("\n");
		this.pending = parts.pop() ?? "";
		const overflow = this.pending.length > this.max || parts.some((p) => p.length > this.max);
		return { lines: parts.filter((p) => p.trim() !== ""), overflow };
	}

	/** What is left once the sender has finished: a last line it did not terminate. */
	flush(): string | undefined {
		const rest = this.pending;
		this.pending = "";
		return rest.trim() === "" ? undefined : rest;
	}
}

export function authLine(token: string): string {
	return `${JSON.stringify({ type: "auth", token })}\n`;
}

/** The token of an auth line, or undefined when the line is anything else. */
export function readAuth(line: string): string | undefined {
	const frame = parseJson(line);
	return frame?.type === "auth" && typeof frame.token === "string" ? frame.token : undefined;
}

export function userFrame(opts: { msgId: string; from: string; content: string; sessionId?: string }): Record<string, unknown> {
	return {
		msg_id: opts.msgId,
		type: "user",
		priority: "next",
		from: opts.from,
		...(opts.sessionId && { session_id: opts.sessionId }),
		message: { role: "user", content: opts.content },
	};
}

export interface UserFrame {
	kind: "user";
	msgId?: string;
	/** The sender's address as the frame states it, falling back to the envelope's. */
	address?: string;
	fromName?: string;
	fromSession?: string;
	fromMode?: FromMode;
	/** The message with its envelope removed, or the raw content when it has none Claude would accept. */
	body: string;
	priority: Priority;
}

export interface ReceiptFrame {
	kind: "receipt";
	origMsgId: string;
	status: ReceiptStatus;
	reason?: string;
	dropReason?: string;
	address?: string;
}

export type Inbound =
	| UserFrame
	| ReceiptFrame
	| { kind: "ignored"; reason: "session-mismatch" | "malformed" | "unhandled" };

function parseJson(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const texts = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string);
	return texts.length ? texts.join("\n") : undefined;
}

/** Claude reports a refusal as an expiry with a detail; callers want to see the refusal. */
export function receiptStatus(status: unknown, detail: unknown): ReceiptStatus | undefined {
	if (status === "expired" && detail === "refused") return "refused";
	return STATUSES.find((s) => s === status);
}

/** What one inbound line asks of us, given the session id we are registered under. */
export function readFrame(line: string, sessionId: string): Inbound {
	const frame = parseJson(line);
	if (!frame) return { kind: "ignored", reason: "malformed" };
	if (frame.type === "user") {
		// A frame addressed to a previous occupant of this pid or socket is not ours.
		if (typeof frame.session_id === "string" && frame.session_id !== sessionId) return { kind: "ignored", reason: "session-mismatch" };
		const message = frame.message as { content?: unknown } | undefined;
		const content = contentText(message?.content);
		if (content === undefined) return { kind: "ignored", reason: "malformed" };
		const env = parseEnvelope(content);
		return {
			kind: "user",
			msgId: str(frame.msg_id),
			address: str(frame.from) ?? env?.from,
			fromName: env?.fromName,
			fromSession: env?.fromSession,
			fromMode: env?.fromMode,
			body: env ? env.body : content,
			priority: PRIORITIES.find((p) => p === frame.priority) ?? "next",
		};
	}
	if (frame.type === "control" && frame.action === "peer_message_status") {
		const origMsgId = str(frame.orig_msg_id);
		const status = receiptStatus(frame.status, frame.status_detail);
		if (!origMsgId || !status) return { kind: "ignored", reason: "malformed" };
		return {
			kind: "receipt",
			origMsgId,
			status,
			reason: str(frame.reason),
			dropReason: str(frame.drop_reason),
			address: str(frame.from),
		};
	}
	return { kind: "ignored", reason: "unhandled" };
}
