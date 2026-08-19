import { describe, expect, it } from "bun:test";
import { type StashTheme, clampIndex, overlayCommand, previewOf, renderStash } from "./overlay.ts";

/** A theme that tags instead of colouring, so layout can be asserted on. */
const theme: StashTheme = {
	fg: (slot, text) => `<${slot}>${text}</${slot}>`,
};

describe("overlayCommand", () => {
	it.each([
		["\x1b[A", -1],
		["\x1bOA", -1],
		["k", -1],
		["\x1b[B", 1],
		["\x1bOB", 1],
		["j", 1],
	])("maps %j to a move", (data, delta) => {
		expect(overlayCommand(data)).toEqual({ kind: "move", delta });
	});

	it.each([
		["\r", "restore"],
		["\n", "restore"],
		["r", "restore"],
		["y", "copy"],
		["d", "delete"],
		["D", "clearAll"],
		["\x1b", "close"],
		["q", "close"],
		["\x03", "close"],
	])("maps %j to %s", (data, kind) => {
		expect(overlayCommand(data)).toEqual({ kind });
	});

	it("ignores a key it does not bind", () => {
		expect(overlayCommand("z")).toBeUndefined();
	});

	// Escape must close, and an arrow key starts with the same byte.
	it("does not read an arrow key as escape", () => {
		expect(overlayCommand("\x1b[C")).toBeUndefined();
	});
});

describe("clampIndex", () => {
	it("keeps an index inside the list", () => {
		expect(clampIndex(2, 5)).toBe(2);
	});

	it("wraps past the end back to the start", () => {
		expect(clampIndex(5, 5)).toBe(0);
	});

	it("wraps before the start round to the end", () => {
		expect(clampIndex(-1, 5)).toBe(4);
	});

	it("is zero for an empty list", () => {
		expect(clampIndex(3, 0)).toBe(0);
	});
});

describe("previewOf", () => {
	it("keeps a short single line as it is", () => {
		expect(previewOf("fix the parser", 40)).toBe("fix the parser");
	});

	it("collapses a multi-line draft onto one row", () => {
		expect(previewOf("first line\nsecond line", 40)).toBe("first line second line");
	});

	it("collapses runs of whitespace", () => {
		expect(previewOf("a    b\t\tc", 40)).toBe("a b c");
	});

	it("truncates with an ellipsis", () => {
		expect(previewOf("abcdefghij", 5)).toBe("abcd…");
	});

	it("survives a width with no room at all", () => {
		expect(previewOf("abc", 0)).toBe("");
	});

	it("marks an entry that is only whitespace", () => {
		expect(previewOf("   \n  ", 40)).toBe("(blank)");
	});
});

describe("renderStash", () => {
	const entries = ["first draft", "second draft"];

	it("numbers each entry with the register that reads it", () => {
		const rows = renderStash(entries, 0, 60, true, theme).join("\n");
		expect(rows).toContain("0");
		expect(rows).toContain("first draft");
		expect(rows).toContain("1");
		expect(rows).toContain("second draft");
	});

	it("marks the selected row and only that row", () => {
		const rows = renderStash(entries, 1, 60, true, theme);
		const marked = rows.filter((row) => row.includes("<accent>"));
		expect(marked).toHaveLength(1);
		expect(marked[0]).toContain("second draft");
	});

	it("says so when the stash is empty", () => {
		expect(renderStash([], 0, 60, true, theme).join("\n")).toContain("empty");
	});

	it("lists the keys it binds", () => {
		const help = renderStash(entries, 0, 60, true, theme).join("\n");
		for (const key of ["restore", "copy", "delete", "clear"]) expect(help).toContain(key);
	});

	// The user needs to know their drafts will not be there tomorrow.
	it("warns when the stash could not be persisted", () => {
		expect(renderStash(entries, 0, 60, false, theme).join("\n")).toContain("memory");
	});

	it("says nothing about persistence when the file is working", () => {
		expect(renderStash(entries, 0, 60, true, theme).join("\n")).not.toContain("memory");
	});

	it("renders at a narrow width without throwing", () => {
		expect(() => renderStash(entries, 0, 4, true, theme)).not.toThrow();
	});
});
