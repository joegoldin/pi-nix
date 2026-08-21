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
		expect(printableKey("\x1b[103;5u")).toBeUndefined();
		expect(printableKey("\x07")).toBeUndefined();
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
		expect(reader().feed("\x07", 0)).toEqual({ consume: true, pending: true, stage: "prefix" });
	});

	it.each([
		["s", "stash"],
		["c", "copy"],
		["x", "cut"],
	])("resolves ctrl+g then %s", (key, kind) => {
		const r = reader();
		r.feed("\x07", 0);
		expect(r.feed(key, 10)).toEqual({ consume: true, pending: false, action: { kind } });
	});

	it("expires and lets the late key through untouched", () => {
		const r = reader();
		r.feed("\x07", 0);
		expect(r.feed("s", CHORD_TIMEOUT_MS + 1)).toEqual({ consume: false, pending: false });
	});

	it("starts a fresh chord when the prefix arrives after an expiry", () => {
		const r = reader();
		r.feed("\x07", 0);
		expect(r.feed("\x07", CHORD_TIMEOUT_MS + 1)).toEqual({ consume: true, pending: true, stage: "prefix" });
	});

	it("cancel() forgets a pending chord", () => {
		const r = reader();
		r.feed("\x07", 0);
		r.cancel();
		expect(r.feed("s", 10)).toEqual({ consume: false, pending: false });
	});
});

describe("ChordReader prefix toggles", () => {
	const reader = () => new ChordReader();

	it("closes an open chord when the prefix is pressed again", () => {
		const r = reader();
		expect(r.feed("\x07", 0)).toEqual({ consume: true, pending: true, stage: "prefix" });
		expect(r.feed("\x07", 10)).toEqual({ consume: true, pending: false });
		// Closed, so the next letter is the prompt's, not the chord's.
		expect(r.feed("s", 20)).toEqual({ consume: false, pending: false });
	});

	it("consumes the closing press, so it never reaches the prompt", () => {
		const r = reader();
		r.feed("\x07", 0);
		expect(r.feed("\x07", 10).consume).toBe(true);
	});

	it("opens again on the next press", () => {
		const r = reader();
		r.feed("\x07", 0);
		r.feed("\x07", 10);
		expect(r.feed("\x07", 20)).toEqual({ consume: true, pending: true, stage: "prefix" });
		expect(r.feed("s", 30)).toEqual({ consume: true, pending: false, action: { kind: "stash" } });
	});
});

describe("ChordReader and key releases", () => {
	const reader = () => new ChordReader();

	it("does not let the release of ctrl+g complete its own chord", () => {
		// The exact shape ghostty sends with Kitty flags 7: the press, then the
		// release of `s` reported with no modifier still held. That release used
		// to read as a plain `s` and fire the stash the moment you pressed the
		// prefix.
		const r = reader();
		expect(r.feed("\x1b[103;5u", 0)).toEqual({ consume: true, pending: true, stage: "prefix" });
		expect(r.feed("\x1b[115;1:3u", 5)).toEqual({ consume: false, pending: true, stage: "prefix" });
		expect(r.feed("\x1b[103;5:3u", 6)).toEqual({ consume: false, pending: true, stage: "prefix" });
		// Still waiting, so the real second key still lands.
		expect(r.feed("u", 10)).toEqual({ consume: true, pending: false, action: { kind: "unstash" } });
	});

	it("keeps the menu up across a release, rather than reporting idle", () => {
		const r = reader();
		r.feed("\x07", 0);
		const step = r.feed("\x1b[115;1:3u", 5);
		expect(step.pending).toBe(true);
		expect(step.consume).toBe(false);
	});

	it("passes a release through untouched when no chord is open", () => {
		expect(reader().feed("\x1b[115;1:3u", 0)).toEqual({ consume: false, pending: false });
	});

	it("does not mistake pasted text for a release", () => {
		// A MAC address in a paste contains ":3F". pi-tui guards this case; so
		// must this, or a paste would be swallowed as a key event.
		const r = reader();
		r.feed("\x07", 0);
		const step = r.feed("\x1b[200~90:62:3F:A5\x1b[201~", 5);
		expect(step.consume).toBe(true);
	});

	it("still acts on a real press that carries an event type of 1", () => {
		const r = reader();
		r.feed("\x07", 0);
		expect(r.feed("\x1b[115;1:1u", 5)).toEqual({
			consume: true,
			pending: false,
			action: { kind: "stash" },
		});
	});
});

describe("ChordReader and shifted second keys", () => {
	const reader = () => new ChordReader();

	it("reads a legacy shifted letter", () => {
		const r = reader();
		r.feed("\x07", 0);
		expect(r.feed("U", 5)).toEqual({ consume: true, pending: false, action: { kind: "unstashAll" } });
	});

	it("reads Kitty's shift modifier without an alternate key", () => {
		// `\x1b[117;2u` is shift+u: the unshifted codepoint plus a modifier, and
		// nothing else. Read literally that is a lowercase u, which is unstash
		// one -- the opposite of what was pressed.
		const r = reader();
		r.feed("\x07", 0);
		expect(r.feed("\x1b[117;2u", 5)).toEqual({
			consume: true,
			pending: false,
			action: { kind: "unstashAll" },
		});
	});

	it("prefers the alternate key when the terminal reports one", () => {
		const r = reader();
		r.feed("\x07", 0);
		expect(r.feed("\x1b[117:85;2u", 5)).toEqual({
			consume: true,
			pending: false,
			action: { kind: "unstashAll" },
		});
	});

	it("still reads the unshifted letter as itself", () => {
		const r = reader();
		r.feed("\x07", 0);
		expect(r.feed("\x1b[117;1u", 5)).toEqual({
			consume: true,
			pending: false,
			action: { kind: "unstash" },
		});
	});

	it("does not touch a key held with ctrl or alt", () => {
		const r = reader();
		r.feed("\x07", 0);
		// ctrl+u is not a second key, so the chord cancels rather than unstashing.
		expect(r.feed("\x1b[117;5u", 5)).toEqual({ consume: true, pending: false });
	});
});

describe("ctrl+s on its own", () => {
	const reader = () => new ChordReader();

	it("acts immediately, without opening a chord", () => {
		expect(reader().feed("\x13", 0)).toEqual({
			consume: true,
			pending: false,
			action: { kind: "quick" },
		});
	});

	it("reads the CSI-u form too", () => {
		expect(reader().feed("\x1b[115;5u", 0)).toEqual({
			consume: true,
			pending: false,
			action: { kind: "quick" },
		});
	});

	it("is not fired by a release", () => {
		expect(reader().feed("\x1b[115;5:3u", 0)).toEqual({ consume: false, pending: false });
	});

	it("is a second key like any other once a chord is open", () => {
		// ctrl+g then ctrl+s is not the quick toggle: the chord is waiting for a
		// letter, and a key it does not bind cancels it.
		const r = reader();
		r.feed("\x07", 0);
		expect(r.feed("\x13", 5)).toEqual({ consume: true, pending: false });
	});
});
