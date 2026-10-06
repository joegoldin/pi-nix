import { describe, expect, it } from "bun:test";
import type { Message } from "./broker/types.ts";
import type { PeerRef } from "./peers.ts";
import { ReplyTracker } from "./reply-tracker.ts";

const alice: PeerRef = { transport: "pi", id: "aaaa-1111", name: "alice", cwd: "/" };
const bob: PeerRef = { transport: "claude", id: "claude:bbbb", name: "bob", cwd: "/", address: "uds:/tmp/b.sock" };

function ask(id: string): Message {
	return { id, timestamp: 0, expectsReply: true, content: { text: "?" } };
}

describe("ReplyTracker", () => {
	it("answers the only pending ask", () => {
		const t = new ReplyTracker(60_000);
		t.record(alice, ask("q1"), 0);
		expect(t.resolve({}, 1).message.id).toBe("q1");
	});

	it("prefers the ask the current turn was started for", () => {
		const t = new ReplyTracker(60_000);
		t.record(alice, ask("q1"), 0);
		const second = t.record(bob, ask("q2"), 0);
		t.queueTurn(second);
		t.beginTurn(1);
		expect(t.resolve({}, 1).message.id).toBe("q2");
	});

	it("needs `to` when several are pending and no turn owns one", () => {
		const t = new ReplyTracker(60_000);
		t.record(alice, ask("q1"), 0);
		t.record(bob, ask("q2"), 0);
		expect(() => t.resolve({}, 1)).toThrow("specify `to`");
		expect(t.resolve({ to: "bob" }, 1).message.id).toBe("q2");
	});

	it("refuses a send elsewhere while answering an ask", () => {
		const t = new ReplyTracker(60_000);
		t.queueTurn(t.record(alice, ask("q1"), 0));
		t.beginTurn(1);
		expect(t.activeMismatch(bob.id, 1)?.message.id).toBe("q1");
		expect(t.activeMismatch(alice.id, 1)).toBeNull();
	});

	it("forgets asks past the timeout", () => {
		const t = new ReplyTracker(1000);
		t.record(alice, ask("q1"), 0);
		expect(t.pending(2000)).toEqual([]);
	});

	it("dismisses everywhere at once", () => {
		const t = new ReplyTracker(60_000);
		t.queueTurn(t.record(alice, ask("q1"), 0));
		t.dismiss("q1");
		t.beginTurn(1);
		expect(() => t.resolve({}, 1)).toThrow("No active intercom context");
	});
});
