import { describe, expect, it } from "bun:test";
import { buildEnvelope } from "./envelope.ts";
import { authLine, LineBuffer, readAuth, readFrame, receiptStatus, userFrame } from "./frames.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";
const FROM = "uds:/tmp/cc-socks/9.sock";

describe("LineBuffer", () => {
	it("splits lines across chunks and keeps the tail", () => {
		const b = new LineBuffer(100);
		expect(b.push('{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], overflow: false });
		expect(b.push(":2}\n\n")).toEqual({ lines: ['{"b":2}'], overflow: false });
		expect(b.flush()).toBeUndefined();
	});

	it("hands back an unterminated last line on flush", () => {
		const b = new LineBuffer(100);
		b.push('{"a":1}');
		expect(b.flush()).toBe('{"a":1}');
	});

	it("overflows on a line past the cap, terminated or not", () => {
		expect(new LineBuffer(4).push("12345").overflow).toBe(true);
		expect(new LineBuffer(4).push("12345\n").overflow).toBe(true);
		expect(new LineBuffer(4).push("1234\n").overflow).toBe(false);
	});
});

describe("auth", () => {
	it("round-trips the auth line", () => {
		expect(authLine("ab".repeat(16))).toBe(`{"type":"auth","token":"${"ab".repeat(16)}"}\n`);
		expect(readAuth(authLine("tok").trim())).toBe("tok");
	});

	it("is not fooled by other frames", () => {
		expect(readAuth('{"type":"user","token":"x"}')).toBeUndefined();
		expect(readAuth("not json")).toBeUndefined();
	});
});

describe("userFrame", () => {
	it("has the fields Claude's receiver reads", () => {
		expect(userFrame({ msgId: "m1", from: FROM, content: "c" })).toEqual({
			msg_id: "m1",
			type: "user",
			priority: "next",
			from: FROM,
			message: { role: "user", content: "c" },
		});
	});

	it("names the target session when known", () => {
		expect(userFrame({ msgId: "m1", from: FROM, content: "c", sessionId: "s" }).session_id).toBe("s");
	});
});

describe("readFrame: user", () => {
	const frame = (extra: Record<string, unknown> = {}, content: unknown = buildEnvelope({ from: FROM, fromName: "repo-1a", fromMode: "prompting" }, "hi")) =>
		JSON.stringify({ msg_id: "m1", type: "user", from: FROM, message: { role: "user", content }, ...extra });

	it("strips the envelope and keeps who sent it", () => {
		expect(readFrame(frame(), SESSION)).toEqual({
			kind: "user",
			msgId: "m1",
			address: FROM,
			fromName: "repo-1a",
			fromSession: undefined,
			fromMode: "prompting",
			body: "hi",
			priority: "next",
		});
	});

	it("keeps the raw content when the envelope does not parse", () => {
		const raw = '<cross-session-message from-name="x" from="uds:/a">\nhi\n</cross-session-message>';
		const f = readFrame(frame({}, raw), SESSION);
		expect(f.kind === "user" && f.body).toBe(raw);
	});

	it("takes the address from the envelope when the frame has none", () => {
		const f = readFrame(JSON.stringify({ type: "user", message: { content: buildEnvelope({ from: FROM }, "x") } }), SESSION);
		expect(f.kind === "user" && f.address).toBe(FROM);
	});

	it("reads text blocks", () => {
		const f = readFrame(frame({}, [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), SESSION);
		expect(f.kind === "user" && f.body).toBe("a\nb");
	});

	it("drops a frame for another session", () => {
		expect(readFrame(frame({ session_id: "someone-else" }), SESSION)).toEqual({ kind: "ignored", reason: "session-mismatch" });
	});

	it("accepts a frame for this session", () => {
		expect(readFrame(frame({ session_id: SESSION }), SESSION).kind).toBe("user");
	});

	it("keeps a known priority and defaults the rest to next", () => {
		const now = readFrame(frame({ priority: "now" }), SESSION);
		const odd = readFrame(frame({ priority: "asap" }), SESSION);
		expect(now.kind === "user" && now.priority).toBe("now");
		expect(odd.kind === "user" && odd.priority).toBe("next");
	});
});

describe("readFrame: receipts", () => {
	const status = (extra: Record<string, unknown>) =>
		JSON.stringify({ type: "control", action: "peer_message_status", from: FROM, orig_msg_id: "m1", reason: "r", ...extra });

	it("maps each status", () => {
		for (const s of ["held", "denied", "expired", "delivered", "refused", "dropped"]) {
			const f = readFrame(status({ status: s }), SESSION);
			expect(f.kind === "receipt" && f.status).toBe(s as never);
		}
	});

	it("reads Claude's refusal, sent as an expiry with a detail", () => {
		expect(receiptStatus("expired", "refused")).toBe("refused");
		const f = readFrame(status({ status: "expired", status_detail: "refused" }), SESSION);
		expect(f).toEqual({ kind: "receipt", origMsgId: "m1", status: "refused", reason: "r", dropReason: undefined, address: FROM });
	});

	it("carries the drop reason", () => {
		const f = readFrame(status({ status: "dropped", drop_reason: "rate-limited" }), SESSION);
		expect(f.kind === "receipt" && f.dropReason).toBe("rate-limited");
	});

	it("ignores an unknown status or a missing id", () => {
		expect(readFrame(status({ status: "teleported" }), SESSION).kind).toBe("ignored");
		expect(readFrame(status({ status: "held", orig_msg_id: undefined }), SESSION).kind).toBe("ignored");
	});
});

describe("readFrame: everything else", () => {
	it("ignores rename, idle subscriptions, artifact hand-offs and junk", () => {
		for (const f of [
			{ type: "control", action: "rename", name: "pwned" },
			{ type: "control", action: "notify_when_idle", from: FROM, msg_id: "x" },
			{ type: "control", action: "peer_idle_notice", orig_msg_id: "x", state: "idle" },
			{ type: "control", action: "yield_artifact_replies" },
			{ type: "assistant" },
		]) {
			expect(readFrame(JSON.stringify(f), SESSION)).toEqual({ kind: "ignored", reason: "unhandled" });
		}
		expect(readFrame("{nope", SESSION)).toEqual({ kind: "ignored", reason: "malformed" });
		expect(readFrame("[1,2]", SESSION)).toEqual({ kind: "ignored", reason: "malformed" });
	});
});
