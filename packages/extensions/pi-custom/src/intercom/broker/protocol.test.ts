import { describe, expect, it } from "bun:test";
import {
	getAskTimeoutMs,
	isMessage,
	isMessageControl,
	isMessageReceipt,
	isSessionInfo,
	isSessionRegistration,
	messageDeliveryFingerprint,
} from "./protocol.ts";
import type { Message } from "./types.ts";

const message = (over: Partial<Message> = {}): Message => ({ id: "m1", timestamp: 1, content: { text: "hi" }, ...over });
const session = { id: "s1", cwd: "/w", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

describe("validators", () => {
	it("accepts a minimal message and one with every optional field", () => {
		expect(isMessage(message())).toBe(true);
		expect(
			isMessage(
				message({
					senderSequence: 1,
					replyTo: "a",
					expectsReply: true,
					supersedes: "b",
					retryOf: "c",
					content: { text: "x", attachments: [{ type: "snippet", name: "n", content: "c", language: "ts" }] },
				}),
			),
		).toBe(true);
	});

	it("rejects mistyped message fields and bad attachments", () => {
		expect(isMessage({ ...message(), id: 1 })).toBe(false);
		expect(isMessage({ ...message(), expectsReply: "yes" })).toBe(false);
		expect(isMessage({ ...message(), content: { text: "x", attachments: [{ type: "image", name: "n", content: "c" }] } })).toBe(false);
		expect(isMessage({ ...message(), content: "text" })).toBe(false);
	});

	it("checks receipts and controls against their closed sets", () => {
		expect(isMessageReceipt({ messageId: "m", status: "injected", timestamp: 1 })).toBe(true);
		expect(isMessageReceipt({ messageId: "m", status: "read", timestamp: 1 })).toBe(false);
		expect(isMessageControl({ messageId: "m", action: "supersede", supersededBy: "n", timestamp: 1 })).toBe(true);
		expect(isMessageControl({ messageId: "m", action: "delete", timestamp: 1 })).toBe(false);
	});

	it("accepts session info from an upstream broker that carries fields this port dropped", () => {
		expect(isSessionInfo({ ...session, herdrLocation: { status: "not_hosted" }, peerUid: 501 })).toBe(true);
		expect(isSessionInfo({ ...session, contextPct: "50" })).toBe(false);
		expect(isSessionRegistration({ cwd: "/w", model: "m", pid: 1, startedAt: 1, lastActivity: 1, tmuxPane: "%1" })).toBe(true);
		expect(isSessionRegistration({ cwd: "/w", model: "m", pid: "1", startedAt: 1, lastActivity: 1 })).toBe(false);
	});
});

describe("delivery fingerprint", () => {
	it("ignores timing fields but not authored content or target", () => {
		const base = messageDeliveryFingerprint(message(), "t");
		expect(messageDeliveryFingerprint(message({ timestamp: 99, senderSequence: 4 }), "t")).toBe(base);
		expect(messageDeliveryFingerprint(message({ content: { text: "other" } }), "t")).not.toBe(base);
		expect(messageDeliveryFingerprint(message(), "u")).not.toBe(base);
	});
});

describe("ask timeout", () => {
	it("defaults to ten minutes and reads PI_INTERCOM_ASK_TIMEOUT_MS", () => {
		expect(getAskTimeoutMs({})).toBe(600_000);
		expect(getAskTimeoutMs({ PI_INTERCOM_ASK_TIMEOUT_MS: "1500" })).toBe(1500);
	});

	it("rejects a non-positive or fractional value", () => {
		expect(() => getAskTimeoutMs({ PI_INTERCOM_ASK_TIMEOUT_MS: "0" })).toThrow(/positive integer/);
		expect(() => getAskTimeoutMs({ PI_INTERCOM_ASK_TIMEOUT_MS: "1.5" })).toThrow(/positive integer/);
	});
});
