import { describe, expect, it } from "bun:test";
import { DuplicateWindow, RateLimiter, TtlMap } from "./guard.ts";

function clock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("RateLimiter", () => {
	it("allows a burst of 30, then refuses", () => {
		const c = clock();
		const r = new RateLimiter(c.now);
		for (let i = 0; i < 30; i++) expect(r.take("a")).toBe(true);
		expect(r.take("a")).toBe(false);
	});

	it("refills one every two seconds", () => {
		const c = clock();
		const r = new RateLimiter(c.now);
		for (let i = 0; i < 30; i++) r.take("a");
		c.advance(1999);
		expect(r.take("a")).toBe(false);
		c.advance(2);
		expect(r.take("a")).toBe(true);
		expect(r.take("a")).toBe(false);
	});

	it("never holds more than a full bucket", () => {
		const c = clock();
		const r = new RateLimiter(c.now);
		c.advance(10 * 60_000);
		for (let i = 0; i < 30; i++) expect(r.take("a")).toBe(true);
		expect(r.take("a")).toBe(false);
	});

	it("keeps senders apart", () => {
		const c = clock();
		const r = new RateLimiter(c.now);
		for (let i = 0; i < 30; i++) r.take("a");
		expect(r.take("b")).toBe(true);
	});
});

describe("DuplicateWindow", () => {
	it("flags a repeat inside 30 s and forgets it after", () => {
		const c = clock();
		const d = new DuplicateWindow(c.now);
		expect(d.seen("m1")).toBe(false);
		c.advance(29_999);
		expect(d.seen("m1")).toBe(true);
		c.advance(1);
		expect(d.seen("m1")).toBe(false);
	});
});

describe("TtlMap", () => {
	it("expires entries oldest first", () => {
		const c = clock();
		const m = new TtlMap<number>(c.now, 1000);
		m.set("a", 1);
		c.advance(500);
		m.set("b", 2);
		expect(m.values()).toEqual([1, 2]);
		c.advance(500);
		expect(m.get("a")).toBeUndefined();
		expect(m.get("b")).toBe(2);
		m.delete("b");
		expect(m.values()).toEqual([]);
	});
});
