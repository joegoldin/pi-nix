import { describe, expect, it } from "bun:test";
import {
	VISIBLE_ROWS,
	type StashTheme,
	clampIndex,
	createStashComponent,
	overlayCommand,
	previewOf,
	renderStash,
} from "./overlay.ts";

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

	it("shows a preview of each entry", () => {
		// Entries used to be numbered, because the number was the register that
		// read them back. The registers are gone; the list is the only way in.
		const rows = renderStash(["first", "second"], 0, 60, true, theme);
		expect(rows.join("\n")).toContain("first");
		expect(rows.join("\n")).toContain("second");
	});

	it("narrows to what matches the filter and says how many", () => {
		const rows = renderStash(["alpha draft", "beta draft", "gamma"], 0, 60, true, theme, "draft").join("\n");
		expect(rows).toContain("alpha draft");
		expect(rows).toContain("beta draft");
		expect(rows).not.toContain("gamma");
		expect(rows).toContain("2 of 3 shown");
	});

	it("says when a filter matches nothing, rather than looking empty", () => {
		const rows = renderStash(["alpha"], 0, 60, true, theme, "zzz").join("\n");
		expect(rows).toContain("nothing matches that");
		expect(rows).not.toContain("the stash is empty");
	});

	it("draws a caret only while the filter is being typed", () => {
		expect(renderStash(["a"], 0, 60, true, theme, "a", true).join("\n")).toContain("\u2588");
		expect(renderStash(["a"], 0, 60, true, theme, "a", false).join("\n")).not.toContain("\u2588");
	});

	it("scrolls rather than drawing every entry", () => {
		const many = Array.from({ length: 25 }, (_, i) => `draft ${i}`);
		const rows = renderStash(many, 0, 60, true, theme);
		const shown = rows.filter((r) => r.includes("draft "));
		expect(shown).toHaveLength(VISIBLE_ROWS);
		expect(rows.join("\n")).toContain("25 of 25 shown");
	});

	it("keeps the selected row inside the window when it scrolls", () => {
		const many = Array.from({ length: 25 }, (_, i) => `draft ${i}`);
		const rows = renderStash(many, 20, 60, true, theme).join("\n");
		expect(rows).toContain("\u25b8 draft 20");
	});

	it("offers different keys while filtering", () => {
		expect(renderStash(["a"], 0, 80, true, theme, "", false).join("\n")).toContain("d delete");
		expect(renderStash(["a"], 0, 80, true, theme, "", true).join("\n")).toContain("type to narrow");
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

describe("createStashComponent with a filter", () => {
	const host = () => {
		let renders = 0;
		return { tui: { requestRender: () => renders++ }, count: () => renders };
	};

	const wire = (entries: string[]) => {
		const state = { entries: [...entries], restored: [] as number[], removed: [] as number[], closed: false };
		const h = host();
		const c = createStashComponent(
			h.tui,
			theme,
			{
				entries: () => state.entries,
				persistent: () => true,
				restore: (i) => state.restored.push(i),
				copy: () => {},
				remove: (i) => {
					state.removed.push(i);
					state.entries.splice(i, 1);
				},
				clearAll: () => {
					state.entries = [];
				},
			},
			() => {
				state.closed = true;
			},
		);
		return { c, state };
	};

	it("acts on the stash's index, not the filtered row's", () => {
		// The one visible row after filtering is entry 2. Restoring row 0 must
		// restore entry 2, or a narrowed list quietly acts on the wrong draft.
		const { c, state } = wire(["alpha", "beta", "gamma"]);
		c.handleInput("/");
		for (const ch of "gam") c.handleInput(ch);
		c.handleInput("\r");
		expect(state.restored).toEqual([2]);
	});

	it("deletes the filtered row and stays open", () => {
		const { c, state } = wire(["alpha", "beta", "gamma"]);
		c.handleInput("/");
		for (const ch of "bet") c.handleInput(ch);
		c.handleInput("\x1b"); // leave the filter so d is a command again
		c.handleInput("d");
		expect(state.removed).toEqual([1]);
		expect(state.closed).toBe(false);
	});

	it("types letters into the query instead of running them as commands", () => {
		const { c, state } = wire(["alpha", "delta"]);
		c.handleInput("/");
		c.handleInput("d"); // would be delete outside the filter
		expect(state.removed).toEqual([]);
		expect(c.render(60).join("\n")).toContain("filter: d");
	});

	it("escape leaves the filter, and only then closes", () => {
		const { c, state } = wire(["alpha"]);
		c.handleInput("/");
		c.handleInput("\x1b");
		expect(state.closed).toBe(false);
		c.handleInput("\x1b");
		expect(state.closed).toBe(true);
	});

	it("backspace edits the query", () => {
		const { c } = wire(["alpha", "beta"]);
		c.handleInput("/");
		for (const ch of "alx") c.handleInput(ch);
		expect(c.render(60).join("\n")).toContain("nothing matches that");
		c.handleInput("\x7f");
		expect(c.render(60).join("\n")).toContain("alpha");
	});
});
