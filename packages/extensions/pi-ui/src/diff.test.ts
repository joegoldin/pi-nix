import { describe, expect, it } from "bun:test";
import type { UiTheme } from "./card.ts";
import { countChanges, parseDiff, renderDiffRows, renderSplit, renderUnified } from "./diff.ts";

const plain: UiTheme = { fg: (_s, t) => t, bold: (t) => t, italic: (t) => t };

// The exact shape pi's generateDiffString produces.
const PI_DIFF = [" 1 import a;", "-2 const x = 1;", "+2 const x = 2;", "+3 const y = 3;", " 3 export { x };", "   ...", " 9 end"].join("\n");

describe("parseDiff", () => {
	it("reads pi's display diff row by row", () => {
		const rows = parseDiff(PI_DIFF);
		expect(rows.map((r) => r.kind)).toEqual(["ctx", "del", "add", "add", "ctx", "skip", "ctx"]);
		expect(rows[1]).toEqual({ kind: "del", line: 2, text: "const x = 1;" });
	});

	it("keeps a row whose text is empty", () => {
		expect(parseDiff("+4 ")[0]).toEqual({ kind: "add", line: 4, text: "" });
	});

	it("counts additions and removals", () => {
		expect(countChanges(parseDiff(PI_DIFF))).toEqual({ added: 2, removed: 1 });
	});
});

describe("rendering", () => {
	const rows = parseDiff(PI_DIFF);

	it("draws unified rows with the sign beside the number", () => {
		const out = renderUnified(rows, 80, plain);
		expect(out[1]).toBe("2 - const x = 1;");
		expect(out[2]).toBe("2 + const x = 2;");
	});

	it("pairs a removal with the addition that replaced it, side by side", () => {
		const out = renderSplit(rows, 80, plain);
		expect(out[1]).toContain("- const x = 1;");
		expect(out[1]).toContain("+ const x = 2;");
		// The second addition has no removal opposite it.
		expect(out[2].split("│")[0].trim()).toBe("");
	});

	it("numbers the new side of context by the new file", () => {
		// One line was replaced and one added, so old line 3 is new line 4.
		const out = renderSplit(rows, 80, plain);
		const [left, right] = out[3].split("│");
		expect(left.trim().startsWith("3")).toBe(true);
		expect(right.trim().startsWith("4")).toBe(true);
	});

	it("switches to side by side only when there is room in auto", () => {
		expect(renderDiffRows(rows, "auto", 120, 100, plain)[1]).not.toContain("│");
		expect(renderDiffRows(rows, "auto", 120, 140, plain)[1]).toContain("│");
		expect(renderDiffRows(rows, "unified", 120, 300, plain)[1]).not.toContain("│");
	});

	it("never draws past the width", () => {
		const wide = parseDiff(`+1 ${"x".repeat(300)}`);
		for (const line of renderSplit(wide, 60, plain)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
	});
});
