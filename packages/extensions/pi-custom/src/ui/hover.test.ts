import { describe, expect, it } from "bun:test";
import { HoverTracker, movesPointer } from "./hover.ts";

describe("HoverTracker", () => {
	it("moves the highlight to whatever claims the pointer", () => {
		const hover = new HoverTracker();
		expect(hover.claim("a", () => {})).toBe(true);
		expect(hover.isHovered("a")).toBe(true);
		expect(hover.claim("a", () => {})).toBe(false);
		expect(hover.claim("b", () => {})).toBe(true);
		expect(hover.isHovered("a")).toBe(false);
	});

	it("keeps the highlight while each report is claimed", () => {
		const hover = new HoverTracker();
		hover.claim("a", () => {});
		hover.settle();
		expect(hover.isHovered("a")).toBe(true);
	});

	it("clears it and repaints the old owner when a report goes unclaimed", () => {
		const hover = new HoverTracker();
		let repainted = 0;
		hover.claim("a", () => repainted++);
		hover.settle();
		hover.settle();
		expect(hover.isHovered("a")).toBe(false);
		expect(repainted).toBe(1);
		hover.settle();
		expect(repainted).toBe(1);
	});
});

describe("movesPointer", () => {
	it("sees motion and wheel reports", () => {
		expect(movesPointer("\x1b[<35;10;5M")).toBe(true);
		expect(movesPointer("\x1b[<64;10;5M")).toBe(true);
		expect(movesPointer("x\x1b[<0;1;1M\x1b[<35;2;2M")).toBe(true);
	});

	it("ignores clicks, keys and other sequences", () => {
		expect(movesPointer("\x1b[<0;10;5M\x1b[<0;10;5m")).toBe(false);
		expect(movesPointer("hello")).toBe(false);
		expect(movesPointer("\x1b[A")).toBe(false);
	});
});
