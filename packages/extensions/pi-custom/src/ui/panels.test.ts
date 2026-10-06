import { describe, expect, it } from "bun:test";
import type { UiTheme } from "./card.ts";
import { DEFAULTS } from "./config.ts";
import { computeBreakdown, ContextView, formatTokens, renderBar } from "./context.ts";
import { sessionAccent, shimmerFrames } from "./editor.ts";
import { Framed } from "./frame.ts";
import { applySetting, settingItems } from "./settings.ts";

const plain: UiTheme = { fg: (_s, t) => t, bold: (t) => t, italic: (t) => t };

describe("/ui settings", () => {
	it("lists every setting with its current value", () => {
		const items = settingItems(DEFAULTS);
		expect(items).toHaveLength(Object.keys(DEFAULTS).length);
		expect(items.find((i) => i.id === "toolMode")?.currentValue).toBe("on");
		expect(items.find((i) => i.id === "nerdIcons")?.currentValue).toBe("on");
		expect(items.find((i) => i.id === "groupRuns")).toMatchObject({ label: "Group tool runs", currentValue: "on" });
	});

	it("keeps a hand-edited number visible as its own stop", () => {
		const item = settingItems({ ...DEFAULTS, collapsedLines: 7 }).find((i) => i.id === "collapsedLines");
		expect(item?.values).toContain("7");
	});

	it("applies each kind of value", () => {
		expect(applySetting(DEFAULTS, "nerdIcons", "off").nerdIcons).toBe(false);
		expect(applySetting(DEFAULTS, "collapsedLines", "10").collapsedLines).toBe(10);
		expect(applySetting(DEFAULTS, "toolMode", "compact").toolMode).toBe("compact");
		expect(applySetting(DEFAULTS, "groupRuns", "off").groupRuns).toBe(false);
		expect(applySetting(DEFAULTS, "nope", "x")).toBe(DEFAULTS);
	});
});

describe("/context", () => {
	const src = {
		systemPrompt: `${"p".repeat(400)}${"m".repeat(400)}`,
		contextFiles: [{ path: "AGENTS.md", content: "m".repeat(390) }],
		skills: [],
		tools: [{ name: "read", description: "read a file" }],
		messages: [
			{ role: "user", content: "u".repeat(40) },
			{ role: "assistant", content: [{ type: "text", text: "a".repeat(40) }, { type: "toolCall", name: "read", arguments: {} }] },
			{ role: "toolResult", content: [{ type: "text", text: "r".repeat(4000) }] },
		],
		usedTokens: null,
		contextWindow: 10_000,
	};

	it("estimates every category and leaves the rest as free space", () => {
		const b = computeBreakdown(src);
		const by = Object.fromEntries(b.categories.map((c) => [c.id, c.tokens]));
		expect(by.results).toBe(1000);
		expect(by.memory).toBeGreaterThan(90);
		expect(b.measured).toBe(false);
		expect(by.free).toBe(10_000 - b.used);
	});

	it("scales the estimates to pi's own count when it has one", () => {
		const b = computeBreakdown({ ...src, usedTokens: 4000 });
		const total = b.categories.filter((c) => c.id !== "free").reduce((sum, c) => sum + c.tokens, 0);
		expect(Math.abs(total - 4000)).toBeLessThan(10);
		expect(b.measured).toBe(true);
	});

	it("fills the bar to exactly the width", () => {
		expect(Bun.stringWidth(renderBar(computeBreakdown(src), 40, plain))).toBe(40);
	});

	it("previews the selected category and goes back on escape", () => {
		const view = new ContextView(computeBreakdown(src), plain, () => 20, () => {});
		expect(view.render(80)[0]).toContain("tokens");
		view.handleInput("\r");
		expect(view.render(80)[0]).toContain("System prompt");
		view.handleInput("\x1b");
		expect(view.render(80)[0]).toContain("tokens");
	});

	it("formats token counts compactly", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(15_200)).toBe("15.2k");
		expect(formatTokens(1_200_000)).toBe("1.2M");
	});
});

describe("shimmer", () => {
	it("sweeps a band across the whole label and off the end", () => {
		const frames = shimmerFrames("Working…", plain);
		expect(frames.length).toBe([..."Working…"].length + 6);
		for (const f of frames) expect(f.endsWith("Working…")).toBe(true);
	});

	it("colours the band with the session's own accent", () => {
		const slots = new Set<string>();
		shimmerFrames("ab", { ...plain, fg: (slot, t) => (slots.add(slot), t) }, "syntaxString");
		expect(slots).toEqual(new Set(["syntaxString", "muted"]));
	});

	it("gives a session one accent for life and spreads sessions across accents", () => {
		expect(sessionAccent("01a10e01")).toBe(sessionAccent("01a10e01"));
		const seen = new Set(Array.from({ length: 40 }, (_, i) => sessionAccent(`session-${i}`)));
		expect(seen.size).toBeGreaterThan(4);
	});
});

describe("overlay frame", () => {
	it("pads every row to the full width so nothing shows through", () => {
		const framed = new Framed({ render: () => ["short", "a much longer line"], invalidate() {} }, "Title", plain);
		const rows = framed.render(30);
		expect(rows[0]).toContain("Title");
		for (const row of rows) expect(Bun.stringWidth(row)).toBe(30);
	});
});
