import { expect, test } from "bun:test";
import { MinimapEngine } from "./engine.ts";
import { emptySnapshot } from "./state.ts";
import { MinimapView, type Palette } from "./view.ts";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
const { renderLayoutFrame, getScrollViewBox } = await import(
	new URL("./layout.js", import.meta.resolve("@earendil-works/pi-tui")).href
);
const theme: Palette = {
	fg: (_slot, text) => text,
	bg: (_slot, text) => `\x1b[44m${text}\x1b[0m`,
	bold: (text) => text,
};
const event = (patch: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x: 1,
	y: 0,
	screenX: 1,
	screenY: 0,
	width: 38,
	height: 24,
	shift: false,
	alt: false,
	ctrl: false,
	...patch,
});
function fixture() {
	const state = emptySnapshot();
	state.now = "Implement a source-linked sidebar";
	state.recent = Array.from({ length: 6 }, (_, i) => ({
		text: `Milestone ${i}: checked the native sidebar layout, focus routing and source navigation at several terminal widths.`,
		tone: "neutral" as const,
		from: `e${i}`,
		to: `e${i}`,
	}));
	state.lastId = "e5";
	const engine = new MinimapEngine(state, {
		read: () => undefined,
		request: async () => {
			throw Error("No provider in renderer tests");
		},
		changed() {},
		save() {},
	});
	const jumps: string[] = [];
	const view = new MinimapView(engine, theme, {
		switchModel: () => engine.switchModel(),
		jump: (id) => jumps.push(id),
		status: () => "Idle",
		contains: (beat, id) =>
			Number(beat.from.slice(1)) <= Number(id.slice(1)) &&
			Number(beat.to.slice(1)) >= Number(id.slice(1)),
		render() {},
		rows: () => 24,
	});
	return { engine, view, jumps };
}

test("history scrolls independently while Now and usage remain pinned", () => {
	const { view } = fixture();
	const before = renderLayoutFrame(view, 38, 24, () => {});
	const box = getScrollViewBox(before, view.scroll)!;
	expect(box.rect.height).toBeLessThan(24);
	view.scroll.scrollTo(0, { disableFollow: true });
	const after = renderLayoutFrame(view, 38, 24, () => {});
	expect(after.lines.slice(-6)).toEqual(before.lines.slice(-6));
	expect(after.lines.join("\n")).toContain("NOW");
	expect(after.lines.join("\n")).toContain("cost unavailable");
	expect(after.lines.join("\n")).toContain("Milestone 0");
});

test("source clicks use stored identities; model button uses the same switch action", () => {
	const { engine, view, jumps } = fixture();
	renderLayoutFrame(view, 38, 24, () => {});
	const row = view.log.rows.findIndex((row) => row.beat?.from === "e2");
	expect(view.log.handleMouse(event({ y: row }))?.handled).toBe(true);
	expect(jumps).toEqual(["e2"]);
	// HStack contains a divider and the VStack whose first child is the header.
	const panel = view.children[1] as {
		children: Array<{ handleMouse?(event: TuiMouseEvent): unknown }>;
	};
	panel.children[0]!.handleMouse!(event({ x: 30 }));
	expect(engine.state.model).toBe("luna");
	engine.dispose();
});

test("new activity preserves the reader's anchor, including when older beats fold", () => {
	const { engine, view } = fixture();
	renderLayoutFrame(view, 38, 24, () => {});
	const at = view.log.rows.findIndex((row) => row.beat?.from === "e1");
	view.scroll.scrollTo(at, { disableFollow: true });
	engine.state.chapters = [
		{
			text: "Checked the first three milestones",
			tone: "neutral",
			from: "e0",
			to: "e2",
		},
	];
	engine.state.recent.splice(0, 3);
	engine.state.recent.push({
		text: "New verification",
		tone: "success",
		from: "e6",
		to: "e6",
	});
	engine.state.lastId = "e6";
	view.refresh();
	const frame = renderLayoutFrame(view, 38, 24, () => {});
	expect(view.scroll.isFollowingEnd).toBe(false);
	expect(view.log.rows[view.scroll.scrollTop]?.beat?.from).toBe("e0");
	expect(frame.lines.join("\n")).toContain("↓ New activity");
	const panel = view.children[1] as {
		children: Array<{ handleMouse?(event: TuiMouseEvent): unknown }>;
	};
	panel.children.at(-1)!.handleMouse!(event());
	expect(view.scroll.isFollowingEnd).toBe(true);
});

test("wheel over pinned controls is contained in the sidebar", () => {
	const { view } = fixture();
	renderLayoutFrame(view, 38, 24, () => {});
	const before = view.scroll.scrollTop;
	expect(
		view.handleMouse(event({ type: "wheel", wheelDelta: -3, y: 23 }))?.handled,
	).toBe(true);
	expect(view.scroll.scrollTop).toBe(before - 3);
});

test("actual fullscreen mouse dispatch routes clicks and wheel without stealing prompt focus", async () => {
	const { TuiAltScreen, Container, Text, HStack, ScrollView } = await import(
		"@earendil-works/pi-tui"
	);
	const { engine, view, jumps } = fixture();
	const terminal = {
		columns: 140,
		rows: 24,
		start() {},
		stop() {},
		write() {},
		hideCursor() {},
		showCursor() {},
	};
	const tui = new TuiAltScreen(terminal as any) as any;
	tui.requestRender = () => {};
	const chat = new Container();
	chat.addChild(new Text("Chat history\n".repeat(100), 0, 0));
	const primary = new ScrollView(chat, { primary: true, follow: "end" });
	const root = new HStack([
		{ component: primary, basis: 0, grow: 1 },
		{ component: view, basis: 38, shrink: 0 },
	]);
	const draw = () => {
		tui.currentLayout = renderLayoutFrame(root, 140, 24, () => {});
		return tui.currentLayout;
	};
	const find = (box: any, component: unknown): any =>
		box.component === component
			? box
			: box.children.map((child: any) => find(child, component)).find(Boolean);
	const click = (x: number, y: number) => {
		tui.handleViewportInput(`\x1b[<0;${x + 1};${y + 1}M`);
		tui.handleViewportInput(`\x1b[<0;${x + 1};${y + 1}m`);
	};
	const focus = { focused: false, render: () => [""] };
	tui.setFocus(focus);
	let frame = draw();
	const panel = view.children[1] as any;
	const header = find(frame.root, panel.children[0]);
	click(header.rect.x + 30, header.rect.y);
	expect(engine.state.model).toBe("luna");
	expect(focus.focused).toBe(true);
	view.scroll.scrollTo(0, { disableFollow: true });
	frame = draw();
	const log = getScrollViewBox(frame, view.scroll)!;
	const sourceRow = view.log.rows.findIndex((row) => row.beat?.from === "e0");
	click(log.rect.x + 2, log.rect.y + sourceRow);
	expect(jumps).toEqual(["e0"]);
	expect(focus.focused).toBe(true);
	view.scroll.scrollToEnd();
	draw();
	const before = primary.scrollTop;
	tui.handleViewportInput(`\x1b[<64;${header.rect.x + 2};24M`);
	expect(primary.scrollTop).toBe(before);
	expect(view.scroll.isFollowingEnd).toBe(false);
	engine.dispose();
});

test("transient scrollbar overlays a reserved gutter, never summary text", async () => {
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const { engine, view } = fixture();
	engine.state.recent[0]!.text = "x".repeat(35);
	expect(view.log.render(37).every((line) => visibleWidth(line) <= 36)).toBe(
		true,
	);
});

test("event ages and the small key render without making observer requests", () => {
	const { engine, view } = fixture();
	engine.state.recent[0]!.at = Date.now() - 8 * 60_000;
	engine.state.recent[0]!.kind = "ask";
	const requests = engine.state.usage.requests;
	expect(view.log.render(37).join("\n")).toContain("8m ago");
	expect(view.render(38).join("\n")).toContain("? ask");
	view.refresh();
	expect(engine.state.usage.requests).toBe(requests);
});

test("human ages use minutes, hours and days and leave unknown times blank", async () => {
	const { relativeAge } = await import("./view.ts");
	const now = Date.now();
	expect(relativeAge(now - 20_000, now)).toBe("just now");
	expect(relativeAge(now - 8 * 60_000, now)).toBe("8m ago");
	expect(relativeAge(now - 2 * 3600_000, now)).toBe("2h ago");
	expect(relativeAge(now - 2 * 86400_000, now)).toBe("2d ago");
	expect(relativeAge(undefined, now)).toBe("");
	expect(relativeAge(NaN, now)).toBe("");
});

test("NOW fits two parent topics and one child level into four physical lines", async () => {
	const { purposeRows } = await import("./view.ts");
	const { parseSummary } = await import("./state.ts");
	const summary = parseSummary(
		JSON.stringify({
			beat: "",
			tone: "neutral",
			now: "Improve minimap",
			focus: [
				{
					topic: "Minimap",
					subtopics: ["Batch summaries", "Remove repeats", "Layout"],
				},
				{
					topic: "Prices",
					subtopics: ["Check current provider rates", "Test estimates"],
				},
			],
		}),
		false,
		false,
	);
	const rows = purposeRows(summary, 24);
	expect(rows).toHaveLength(4);
	expect(rows[0]).toContain("Minimap");
	expect(rows[2]).toContain("Prices");
	expect(rows.filter((row) => row.startsWith("  "))).toHaveLength(2);
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	expect(rows.every((row) => visibleWidth(row) <= 24)).toBe(true);
});

test("legacy earlier paragraphs render as three complete source-linked bullets", () => {
	const { engine, view } = fixture();
	engine.state.earlier = {
		from: "old",
		to: "old",
		tone: "neutral",
		text:
			"Kept the editor full width. Limited model requests to useful batches. " +
			"Preserved original source links ".repeat(30),
	};
	view.log.render(37);
	const bullets = [
		...new Set(
			view.log.rows
				.filter((row) => row.beat?.from === "old")
				.map((row) => row.beat!.text),
		),
	];
	expect(bullets).toHaveLength(3);
	expect(bullets[2]).toBe("Preserved original source links ".repeat(30).trim());
});

test("catch-up notices explain sampling and leave a blank line before the summary", () => {
	const { engine, view } = fixture();
	engine.state.recent = [{ text: "Work continued.", tone: "neutral", from: "e0", to: "e1", recap: true, omitted: 11 }];
	for (const width of [28, 38, 90]) {
		const lines = view.log.render(width);
		const summary = lines.findIndex(line => line.includes("Work continued."));
		expect(lines.slice(1, summary).filter(Boolean).join(" ")).toBe("↻ Catch-up summary · 11 intermediate events not reviewed");
		expect(lines[summary - 1]).toBe("");
	}
	engine.state.recent[0]!.omitted = undefined;
	const lines = view.log.render(38);
	expect(lines).toContain("↻ Catch-up summary");
	expect(lines[lines.findIndex(line => line.includes("Work continued.")) - 1]).toBe("");
});


test("long log entries wrap fully and their endings remain reachable by scrolling", () => {
	const { engine, view } = fixture();
	engine.state.recent = [{ text: "Full context rather than clipping. ".repeat(30) + "RECENT_END", tone: "neutral", from: "e0", to: "e0" }];
	engine.state.chapters = [{ text: "Milestone context. ".repeat(30) + "MILESTONE_END", tone: "neutral", from: "e1", to: "e1" }];
	engine.state.earlier = { text: "Earlier context. ".repeat(30) + "EARLIER_END", bullets: ["Earlier context. ".repeat(30) + "EARLIER_END"], tone: "neutral", from: "e2", to: "e2" };
	renderLayoutFrame(view, 38, 24, () => {});
	for (const marker of ["EARLIER_END", "MILESTONE_END", "RECENT_END"]) {
		const row = view.log.rows.findIndex(row => row.text.includes(marker));
		expect(row).toBeGreaterThan(0);
		view.scroll.scrollTo(Math.max(0, row - 2), { disableFollow: true });
		expect(renderLayoutFrame(view, 38, 24, () => {}).lines.join("\n")).toContain(marker);
	}
	engine.dispose();
});
