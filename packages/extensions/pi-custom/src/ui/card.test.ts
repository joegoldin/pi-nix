import { describe, expect, it } from "bun:test";
import { BODY_GUTTER, type CardLayout, type CardModel, header, layoutCard, type UiTheme } from "./card.ts";

const plain: UiTheme = { fg: (_s, t) => t, bold: (t) => t, italic: (t) => t };

const layout = (over: Partial<CardLayout> = {}): CardLayout => ({
	mode: "on",
	expanded: false,
	collapsedLines: 2,
	expandedLines: 4,
	expandHint: "(ctrl+o to expand)",
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

	it("folds the body behind the expand hint, counting what it hid", () => {
		const rows = layoutCard(model(), layout(), plain, 80);
		expect(rows.at(-1)).toContain("… +3 lines (ctrl+o to expand)");
	});

	it("shows more when expanded, still capped, without the hint", () => {
		const rows = layoutCard(model(), layout({ expanded: true }), plain, 80);
		expect(rows.at(-1)).toContain("… +1 line");
		expect(rows.at(-1)).not.toContain("expand");
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

	it("clips rows to the width instead of wrapping them", () => {
		const rows = layoutCard(model({ target: "x".repeat(200) }), layout(), plain, 30);
		expect(rows.every((r) => Bun.stringWidth(r) <= 30)).toBe(true);
	});

	it("gives a width-dependent body the width left after the gutter", () => {
		let seen = 0;
		layoutCard(model({ body: (w) => ((seen = w), ["x"]) }), layout(), plain, 50);
		expect(seen).toBe(50 - BODY_GUTTER);
	});
});
