import { describe, expect, it } from "bun:test";
import { VoiceGesture } from "./gesture.ts";

describe("voice Space gesture", () => {
	it("starts with one Space in an empty prompt and stops with one Space", () => {
		const gesture = new VoiceGesture();
		expect(gesture.feed(" ", "", false)).toBe("start");
		expect(gesture.feed(" ", "", true)).toBe("stop");
	});

	it("does not activate in existing text or whitespace", () => {
		for (const text of ["draft", " ", "\n", "\t", "[image]"]) {
			const gesture = new VoiceGesture();
			expect(gesture.feed(" ", text, false)).toBeUndefined();
			expect(gesture.feed(" ", text + " ", false)).toBeUndefined();
		}
	});

	it("leaves other keys alone", () => {
		for (const key of ["x", "\x1b", "\x7f", "\x1b[D", "\x1b[32;5u"]) {
			for (const active of [false, true]) {
				expect(new VoiceGesture().feed(key, "", active)).toBeUndefined();
			}
		}
	});

	it("accepts Kitty Space presses and lock modifiers but not modified Space", () => {
		for (const key of ["\x1b[32u", "\x1b[32;1u", "\x1b[32;1:1u", "\x1b[32:32:32;193:1u"]) {
			expect(new VoiceGesture().feed(key, "", false)).toBe("start");
		}
		for (const key of ["\x1b[32;2u", "\x1b[32;3u", "\x1b[32;5u", "\x1b[32;9u", "\x1b "]) {
			expect(new VoiceGesture().feed(key, "", true)).toBeUndefined();
		}
	});

	it("does not start or stop on a reported hold or release", () => {
		const gesture = new VoiceGesture();
		expect(gesture.feed("\x1b[32;1:2u", "", false)).toBeUndefined();
		expect(gesture.feed("\x1b[32;1:3u", "", false)).toBeUndefined();
		expect(gesture.feed("\x1b[32;1:2u", "", true)).toBe("consume");
		expect(gesture.feed("\x1b[32;1:3u", "", true)).toBeUndefined();
		expect(gesture.feed(" ", "", true)).toBe("stop");
	});

	it("passes whole and chunked pastes through even while recording", () => {
		for (const active of [false, true]) {
			const gesture = new VoiceGesture();
			expect(gesture.feed("  ", "", active)).toBeUndefined();
			expect(gesture.feed("\x1b[200~  \x1b[201~", "", active)).toBeUndefined();
			expect(gesture.feed("\x1b[200~", "", active)).toBeUndefined();
			expect(gesture.feed(" ", "", active)).toBeUndefined();
			expect(gesture.feed(" ", " ", active)).toBeUndefined();
			expect(gesture.feed("\x1b[201~", "  ", active)).toBeUndefined();
			expect(gesture.feed(" ", "", active)).toBe(active ? "stop" : "start");
		}
	});

	it("stops an active recording even when the draft is nonempty", () => {
		expect(new VoiceGesture().feed(" ", "existing draft", true)).toBe("stop");
	});
});
