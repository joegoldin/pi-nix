import { describe, expect, it } from "bun:test";
import { CHORD_TIMEOUT_MS, ChordReader, matchesAlt, matchesCtrl, printableKey } from "./chord.ts";

describe("matchesCtrl", () => {
	it("matches the legacy control character", () => {
		expect(matchesCtrl("\x13", "s")).toBe(true);
	});

	it("matches the Kitty CSI-u form with the ctrl bit set", () => {
		expect(matchesCtrl("\x1b[115;5u", "s")).toBe(true);
	});

	it("matches a Kitty sequence that also carries an event type", () => {
		expect(matchesCtrl("\x1b[115;5:1u", "s")).toBe(true);
	});

	it("ignores caps lock and num lock, which ride along in the modifier field", () => {
		expect(matchesCtrl("\x1b[115;69u", "s")).toBe(true);
	});

	it("rejects the same letter without ctrl", () => {
		expect(matchesCtrl("s", "s")).toBe(false);
		expect(matchesCtrl("\x1b[115u", "s")).toBe(false);
	});

	it("rejects a different letter", () => {
		expect(matchesCtrl("\x04", "s")).toBe(false);
	});
});

describe("matchesAlt", () => {
	it("matches the legacy escape-prefixed form", () => {
		expect(matchesAlt("\x1bi", "i")).toBe(true);
	});

	it("matches the Kitty CSI-u form with the alt bit set", () => {
		expect(matchesAlt("\x1b[105;3u", "i")).toBe(true);
	});

	it("rejects the bare letter", () => {
		expect(matchesAlt("i", "i")).toBe(false);
	});
});

describe("printableKey", () => {
	it("returns a bare character", () => {
		expect(printableKey("s")).toBe("s");
		expect(printableKey("7")).toBe("7");
	});

	it("decodes an unmodified Kitty sequence", () => {
		expect(printableKey("\x1b[115u")).toBe("s");
		expect(printableKey("\x1b[115;1u")).toBe("s");
	});

	it("returns undefined for a modified key, which is never chord input", () => {
		expect(printableKey("\x1b[115;5u")).toBeUndefined();
		expect(printableKey("\x13")).toBeUndefined();
	});

	it("returns undefined for a multi-character paste", () => {
		expect(printableKey("hello")).toBeUndefined();
	});
});

describe("ChordReader", () => {
	const reader = () => new ChordReader();

	it("passes ordinary keys straight through", () => {
		expect(reader().feed("s", 0)).toEqual({ consume: false, pending: false });
	});

	it("consumes the prefix and waits, naming what it waits for", () => {
		// `stage` is what the on-screen prompt is drawn from, so it is part of
		// the contract rather than a detail.
		expect(reader().feed("\x13", 0)).toEqual({ consume: true, pending: true, stage: "prefix" });
	});

	it.each([
		["s", "stash"],
		["u", "undo"],
		["r", "redo"],
		["y", "copy"],
		["d", "cut"],
		["t", "thinking"],
	])("resolves ctrl+s then %s", (key, kind) => {
		const r = reader();
		r.feed("\x13", 0);
		expect(r.feed(key, 10)).toEqual({ consume: true, pending: false, action: { kind } });
	});

	it("resolves a numbered register append through the second prefix", () => {
		const r = reader();
		r.feed("\x13", 0);
		expect(r.feed("a", 10)).toEqual({ consume: true, pending: true, stage: "append" });
		expect(r.feed("4", 20)).toEqual({ consume: true, pending: false, action: { kind: "append", register: "4" } });
	});

	it("resolves the stash register append", () => {
		const r = reader();
		r.feed("\x13", 0);
		r.feed("a", 10);
		expect(r.feed("s", 20).action).toEqual({ kind: "append", register: "s" });
	});

	it("recognises alt+i outside any chord", () => {
		expect(reader().feed("\x1bi", 0)).toEqual({ consume: true, pending: false, action: { kind: "tab" } });
	});

	// An unknown key must not reach the editor: the user was mid-chord, and a
	// stray letter appearing in the prompt is the failure this cancels.
	it("cancels on an unknown key and swallows it", () => {
		const r = reader();
		r.feed("\x13", 0);
		expect(r.feed("q", 10)).toEqual({ consume: true, pending: false });
		expect(r.feed("s", 20)).toEqual({ consume: false, pending: false });
	});

	it("cancels on escape", () => {
		const r = reader();
		r.feed("\x13", 0);
		expect(r.feed("\x1b", 10)).toEqual({ consume: true, pending: false });
	});

	it("cancels the append step on an unknown key", () => {
		const r = reader();
		r.feed("\x13", 0);
		r.feed("a", 10);
		expect(r.feed("z", 20)).toEqual({ consume: true, pending: false });
	});

	// A chord left hanging must expire, and the key that arrives afterwards is
	// an ordinary keystroke rather than the tail of a chord nobody remembers.
	it("expires and lets the late key through untouched", () => {
		const r = reader();
		r.feed("\x13", 0);
		expect(r.feed("s", CHORD_TIMEOUT_MS + 1)).toEqual({ consume: false, pending: false });
	});

	it("starts a fresh chord when the prefix arrives after an expiry", () => {
		const r = reader();
		r.feed("\x13", 0);
		expect(r.feed("\x13", CHORD_TIMEOUT_MS + 1)).toEqual({ consume: true, pending: true, stage: "prefix" });
	});

	it("expires the append step too", () => {
		const r = reader();
		r.feed("\x13", 0);
		r.feed("a", 10);
		expect(r.feed("4", CHORD_TIMEOUT_MS + 11)).toEqual({ consume: false, pending: false });
	});

	it("cancel() forgets a pending chord", () => {
		const r = reader();
		r.feed("\x13", 0);
		r.cancel();
		expect(r.feed("s", 10)).toEqual({ consume: false, pending: false });
	});
});

describe("ChordReader prefix repeats", () => {
	const reader = () => new ChordReader();

	it("restarts the chord when the prefix is pressed twice", () => {
		const r = reader();
		expect(r.feed("\x13", 0)).toEqual({ consume: true, pending: true, stage: "prefix" });
		// Was CANCELLED: ctrl+s is not printable, so it fell past SECOND_KEY.
		expect(r.feed("\x13", 10)).toEqual({ consume: true, pending: true, stage: "prefix" });
		expect(r.feed("s", 20)).toEqual({ consume: true, pending: false, action: { kind: "stash" } });
	});

	it("restarts from the register step too", () => {
		const r = reader();
		r.feed("\x13", 0);
		expect(r.feed("a", 10)).toEqual({ consume: true, pending: true, stage: "append" });
		expect(r.feed("\x13", 20)).toEqual({ consume: true, pending: true, stage: "prefix" });
		expect(r.feed("u", 30)).toEqual({ consume: true, pending: false, action: { kind: "undo" } });
	});

	it("keeps the window open from the latest prefix, not the first", () => {
		const r = reader();
		r.feed("\x13", 0);
		r.feed("\x13", CHORD_TIMEOUT_MS - 1);
		expect(r.feed("s", CHORD_TIMEOUT_MS + 100)).toEqual({
			consume: true,
			pending: false,
			action: { kind: "stash" },
		});
	});
});
