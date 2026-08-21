import { describe, expect, it } from "bun:test";
import {
	VISIBLE_ROWS,
	type StashTheme,
	clampIndex,
	createStashComponent,
	overlayCommand,
	previewOf,
	renderStash,
	MAX_HELP_ROWS,
	wrapHelp,
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
		["c", "copy"],
		["d", "delete"],
		["D", "clearAll"],
		["\x1b", "close"],
		["q", "close"],
	])("maps %j to %s", (data, kind) => {
		expect(overlayCommand(data)).toEqual({ kind });
	});

	it("leaves ctrl+c to the caller, so it can dismiss and still interrupt", () => {
		// A component that claimed ctrl+c would swallow an interrupt. The caller
		// closes on it and passes it on.
		expect(overlayCommand("\x03")).toBeUndefined();
		expect(overlayCommand("\x03", true)).toBeUndefined();
	});

	it('leaves "y" unbound, so copy is not one action under two keys', () => {
		// It was y here and c in the chord, which meant the letter depended on
		// which surface you happened to be looking at.
		expect(overlayCommand("y")).toBeUndefined();
	});

	it("ignores a key it does not bind", () => {
		expect(overlayCommand("z")).toBeUndefined();
	});

	// Escape must close, and an arrow key starts with the same byte.
	it("does not read an arrow key as escape", () => {
		// An escape sequence starts with the escape byte, so the close binding
		// must not swallow the whole family. Right is not bound to anything, but
		// it is claimed rather than passed on, or it would reach the prompt
		// behind the list.
		expect(overlayCommand("\x1b[C")).toEqual({ kind: "noop" });
	});

	it("reads the arrows in the encoding the Kitty protocol sends", () => {
		// With event types reported, Up is `\x1b[1;1:1A`, not `\x1b[A`. The old
		// table only knew the legacy form, so the arrows silently did nothing
		// while j and k -- text keys, unaffected -- kept working.
		expect(overlayCommand("\x1b[1;1:1A")).toEqual({ kind: "move", delta: -1 });
		expect(overlayCommand("\x1b[1;1:1B")).toEqual({ kind: "move", delta: 1 });
		expect(overlayCommand("\x1b[A")).toEqual({ kind: "move", delta: -1 });
		expect(overlayCommand("\x1bOB")).toEqual({ kind: "move", delta: 1 });
	});

	it("moves the list while a filter is being typed", () => {
		expect(overlayCommand("\x1b[1;1:1B", true)).toEqual({ kind: "move", delta: 1 });
	});

	it("reads enter and escape in that encoding too", () => {
		expect(overlayCommand("\x1b[13;1:1u")).toEqual({ kind: "restore" });
		expect(overlayCommand("\x1b[27;1:1u")).toEqual({ kind: "close" });
		expect(overlayCommand("\x1b[27;1:1u", true)).toEqual({ kind: "endFilter" });
		expect(overlayCommand("\x1b[127;1:1u", true)).toEqual({ kind: "filterBackspace" });
	});

	it("ignores a release, rather than acting on it twice", () => {
		expect(overlayCommand("\x1b[1;1:3B")).toEqual({ kind: "noop" });
		expect(overlayCommand("\x1b[115;1:3u", true)).toEqual({ kind: "noop" });
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
		expect(rows).toContain("2 of 3 match");
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
		expect(rows.join("\n")).toContain("25 saved");
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

describe("wrapHelp", () => {
	it("keeps the whole line when it fits", () => {
		expect(wrapHelp("a · b · c", 20)).toEqual(["a · b · c"]);
	});

	it("breaks on the separator rather than mid-key", () => {
		// The bug this replaces ended a narrow list on "/ f…", cutting off the
		// name of a key you were meant to be able to read.
		const rows = wrapHelp("enter restore · c copy · d delete · D clear all · / filter · esc close", 34);
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) expect([...row].length).toBeLessThanOrEqual(34);
		expect(rows.join(" ")).toContain("/ filter");
		expect(rows.join(" ")).toContain("esc close");
	});

	it("loses no binding at a width real terminals actually use", () => {
		const help = "enter restore · c copy · d delete · D clear all · / filter · esc close";
		for (const width of [34, 50, 200]) {
			const joined = wrapHelp(help, width).join(" ");
			for (const key of ["enter", "copy", "delete", "clear all", "filter", "close"]) {
				expect(joined).toContain(key);
			}
		}
	});

	it("never returns more than MAX_HELP_ROWS, whatever the width", () => {
		const help = "enter restore · c copy · d delete · D clear all · / filter · esc close";
		for (const width of [4, 8, 12, 20, 34, 50, 200]) {
			expect(wrapHelp(help, width).length).toBeLessThanOrEqual(MAX_HELP_ROWS);
		}
	});

	it("folds the overflow onto the last row rather than dropping it silently", () => {
		// Too narrow for two rows to hold everything: some bindings are cut,
		// but visibly, with an ellipsis, not vanished the way the widget cap
		// would vanish them with no mark at all.
		const help = "enter restore · c copy · d delete · D clear all · / filter · esc close";
		const rows = wrapHelp(help, 12);
		expect(rows.length).toBeLessThanOrEqual(MAX_HELP_ROWS);
		expect(rows[rows.length - 1]).toContain("…");
	});

	it("truncates a single binding too wide to fit, rather than dropping it", () => {
		expect(wrapHelp("an extremely long single binding", 10)).toEqual(["an extrem…"]);
	});

	it("draws nothing when there is no room at all", () => {
		expect(wrapHelp("a · b", 0)).toEqual([]);
	});
});

describe("renderStash and pi's widget cap", () => {
	it("never exceeds pi's ten-line widget cap, even at MAX_STASH", () => {
		// InteractiveMode.MAX_WIDGET_LINES is 10, enforced outside this
		// extension with no signal back to it when it is exceeded -- the ten
		// lines. Reproduced directly: with a full ten-entry stash, the row
		// count here used to be 12 (title + 10 entries + help), and pi silently
		// dropped the last entry and the whole help line.
		const full = Array.from({ length: 10 }, (_, i) => `draft ${i}`);
		for (const width of [40, 80, 120]) {
			expect(renderStash(full, 0, width, true, theme).length).toBeLessThanOrEqual(10);
		}
	});

	it("still shows the count line when the list is longer than the window", () => {
		const full = Array.from({ length: 10 }, (_, i) => `draft ${i}`);
		const rows = renderStash(full, 0, 80, true, theme).join("\n");
		expect(rows).toContain(`10 saved`);
	});
});
