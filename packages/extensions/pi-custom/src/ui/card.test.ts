import { describe, expect, it } from "bun:test";
import { BODY_GUTTER, type CardLayout, type CardModel, header, layoutCard, paint, type UiTheme } from "./card.ts";

const plain: UiTheme = { fg: (_s, t) => t, bold: (t) => t, italic: (t) => t };

const layout = (over: Partial<CardLayout> = {}): CardLayout => ({
	mode: "on",
	expanded: false,
	collapsedLines: 2,
	expandedLines: 4,
	expandHint: "(click or ctrl+o)",
	...over,
});

const model = (over: Partial<CardModel> = {}): CardModel => ({
	title: "Read",
	target: "src/a.ts",
	state: "success",
	summary: "Read 5 lines",
	body: ["1", "2", "3", "4", "5"],
	...over,
});

describe("header", () => {
	it("names the call the way Claude Code does", () => {
		expect(header(model(), plain)).toBe("● Read(src/a.ts)");
	});

	it("puts qualifiers after the target", () => {
		expect(header(model({ detail: "from 10" }), plain)).toBe("● Read(src/a.ts from 10)");
	});

	it("colours the bullet by state", () => {
		const seen: string[] = [];
		const rec: UiTheme = { ...plain, fg: (s, t) => (seen.push(s), t) };
		header(model({ state: "error" }), rec);
		header(model({ state: "pending" }), rec);
		expect(seen).toEqual(["error", "muted"]);
	});
});

describe("layoutCard", () => {
	it("hangs the result off an elbow and indents the body under it", () => {
		const rows = layoutCard(model(), layout(), plain, 80);
		expect(rows[0]).toBe("● Read(src/a.ts)");
		expect(rows[1]).toBe("  ⎿  Read 5 lines");
		expect(rows[2]).toBe(`${" ".repeat(BODY_GUTTER)}1`);
	});

	it("folds the body behind the hint, counting what it hid", () => {
		const rows = layoutCard(model(), layout(), plain, 80);
		expect(rows.at(-1)).toContain("… +3 lines (click or ctrl+o)");
	});

	it("says a capped expanded card hit the view's limit, so it never reads as folded", () => {
		const rows = layoutCard(model(), layout({ expanded: true }), plain, 80);
		expect(rows.at(-1)?.trim()).toBe("… 1 more line not shown (expanded view limit)");
		expect(rows.at(-1)).not.toContain("ctrl+o");
	});

	it("counts rows the producer dropped as plain hidden rows when expanded under the cap", () => {
		const rows = layoutCard(model({ body: ["1"], omitted: 2 }), layout({ expanded: true }), plain, 80);
		expect(rows.at(-1)?.trim()).toBe("… +2 lines");
	});

	it("shows everything when expanded under the cap, with no remainder line", () => {
		const rows = layoutCard(model({ body: ["1", "2"] }), layout({ expanded: true }), plain, 80);
		expect(rows.map((r) => r.trim())).toEqual(["● Read(src/a.ts)", "⎿  Read 5 lines", "1", "2"]);
	});

	it("keeps the last rows for a tail card, with the count above them", () => {
		const rows = layoutCard(model({ summary: undefined, tail: true }), layout(), plain, 80);
		expect(rows[1]).toContain("… +3 lines");
		expect(rows.slice(2).map((r) => r.trim())).toEqual(["4", "5"]);
	});

	it("puts the whole card on one line in compact mode", () => {
		expect(layoutCard(model(), layout({ mode: "compact" }), plain, 80)).toEqual(["● Read(src/a.ts) · Read 5 lines"]);
	});

	it("lets a body line stand in for a missing summary in compact mode", () => {
		expect(layoutCard(model({ summary: undefined, tail: true }), layout({ mode: "compact" }), plain, 80)).toEqual(["● Read(src/a.ts) · 5"]);
	});

	it("opens a compact card fully when expanded", () => {
		expect(layoutCard(model(), layout({ mode: "compact", expanded: true }), plain, 80).length).toBeGreaterThan(1);
	});

	it("clips rows to the width when collapsed", () => {
		const rows = layoutCard(model({ target: "x".repeat(200), body: ["y".repeat(200)] }), layout(), plain, 30);
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => Bun.stringWidth(r) <= 30)).toBe(true);
	});

	it("wraps long rows when expanded, continuing under the same gutter", () => {
		const rows = layoutCard(model({ summary: undefined, body: ["a".repeat(40)] }), layout({ expanded: true }), plain, 30);
		const body = rows.slice(1);
		expect(body).toHaveLength(2);
		expect(body[0].startsWith("  ⎿  ")).toBe(true);
		expect(body[1].startsWith(" ".repeat(BODY_GUTTER))).toBe(true);
		expect(body.map((r) => r.slice(BODY_GUTTER)).join("")).toBe("a".repeat(40));
		expect(body.every((r) => Bun.stringWidth(r) <= 30)).toBe(true);
	});

	it("wraps a long header when expanded instead of cutting the command off", () => {
		const rows = layoutCard(model({ target: "x".repeat(50), summary: undefined, body: [] }), layout({ expanded: true }), plain, 30);
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.join("")).not.toContain("…");
	});

	it("paints every row edge to edge when given a background", () => {
		const bg = "\x1b[48;5;236m";
		const rows = layoutCard(model(), layout({ background: bg }), plain, 40);
		expect(rows.every((r) => r.startsWith(bg) && Bun.stringWidth(r) === 40)).toBe(true);
	});

	it("gives a width-dependent body the width left after the gutter", () => {
		let seen = 0;
		layoutCard(model({ body: (w) => ((seen = w), ["x"]) }), layout(), plain, 50);
		expect(seen).toBe(50 - BODY_GUTTER);
	});
});

describe("paint", () => {
	it("pads to the width and closes the background", () => {
		expect(paint("ab", 4, "<bg>")).toBe("<bg>ab  \x1b[49m");
	});

	it("reopens the background after resets inside the row", () => {
		const row = paint("a\x1b[49mb\x1b[0mc", 3, "<bg>");
		expect(row).toBe("<bg>a\x1b[49m<bg>b\x1b[0m<bg>c\x1b[49m");
	});

	it("leaves foreground resets alone", () => {
		expect(paint("\x1b[31ma\x1b[39m", 1, "<bg>")).toBe("<bg>\x1b[31ma\x1b[39m\x1b[49m");
	});
});
