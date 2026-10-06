import { describe, expect, it } from "bun:test";
import { rgbColor, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { UiTheme } from "./card.ts";
import { DEFAULTS, type UiConfig } from "./config.ts";
import { GroupState, type MessageLike, RunModel } from "./group.ts";
import { HoverTracker } from "./hover.ts";
import { cardRenderers, type RendererDeps, type RenderContextLike } from "./render.ts";

const PANEL = "\x1b[48;5;236m";
// Enough of pi's Theme for the backgrounds: a panel slot and the colours hover is mixed from.
const theme = {
	fg: (_s: string, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	getBgAnsi: () => PANEL,
	colors: { toolPendingBg: rgbColor(60, 60, 60), text: rgbColor(220, 220, 220) },
	getColorMode: () => "truecolor" as const,
} satisfies UiTheme;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function setup(config: Partial<UiConfig> = {}) {
	const model = new RunModel();
	const groups = new GroupState();
	const hover = new HoverTracker();
	let repaints = 0;
	const deps: RendererDeps = {
		config: () => ({ ...DEFAULTS, ...config }),
		highlight: (code) => code.split("\n"),
		languageOf: () => undefined,
		expandKey: () => "ctrl+o",
		runs: { model, groups, toolsExpanded: () => false },
		hover,
	};
	const contexts = new Map<string, RenderContextLike>();
	/** A tool row as pi drives it: renderResult records, renderCall draws. */
	function row(id: string, command: string, output: string, opts: { isError?: boolean; expanded?: boolean } = {}) {
		const r = cardRenderers("bash", deps);
		const context: RenderContextLike = {
			args: { command },
			toolCallId: id,
			state: {},
			cwd: "/repo",
			expanded: opts.expanded ?? false,
			isPartial: false,
			isError: opts.isError ?? false,
			invalidate: () => repaints++,
		};
		contexts.set(id, context);
		r.renderResult?.({ content: [{ type: "text", text: output }] }, { expanded: context.expanded, isPartial: false }, theme, context);
		return r.renderCall?.(context.args, theme, context) as {
			render(width: number): string[];
			handleMouse(event: TuiMouseEvent): { handled?: boolean; render?: boolean } | undefined;
		};
	}
	return { model, groups, hover, row, repaints: () => repaints };
}

const assistant = (...ids: string[]): MessageLike => ({
	role: "assistant",
	content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })),
	stopReason: "toolUse",
});

const mouse = (type: TuiMouseEvent["type"], y: number): TuiMouseEvent => ({
	type,
	button: type === "move" ? "none" : "left",
	x: 2,
	y,
	screenX: 2,
	screenY: y,
	width: 60,
	height: 5,
	shift: false,
	alt: false,
	ctrl: false,
});

describe("a minimized run", () => {
	it("is one line on its first row and nothing on the others", () => {
		const { model, row } = setup();
		model.load([{ type: "message", message: assistant("a", "b") }]);
		expect(row("a", "ls", "x").render(60).map(strip)).toEqual(["Ran 2 shell commands"]);
		expect(row("b", "pwd", "y").render(60)).toEqual([]);
	});

	it("still shows a failed call on its own", () => {
		const { model, row } = setup();
		model.load([
			{ type: "message", message: assistant("a", "b") },
			{ type: "message", message: { role: "toolResult", toolCallId: "b", isError: true } },
		]);
		expect(row("a", "ls", "x").render(60).map(strip)).toEqual(["Ran 2 shell commands (1 failed)"]);
		expect(strip(row("b", "false", "boom", { isError: true }).render(60)[0])).toBe("● Bash(false)");
	});

	it("opens on a click on its line, cards on the panel under it, and folds on the next", () => {
		const { model, row } = setup();
		model.load([{ type: "message", message: assistant("a", "b") }]);
		const head = row("a", "ls", "x");
		head.render(60);
		expect(head.handleMouse(mouse("click", 0))).toEqual({ handled: true });

		const open = head.render(60);
		expect(strip(open[0])).toBe("Ran 2 shell commands");
		expect(open[0].startsWith(PANEL)).toBe(false);
		expect(strip(open[1]).trim()).toBe("● Bash(ls)");
		expect(open.slice(1).every((line) => line.startsWith(PANEL) && Bun.stringWidth(line) === 60)).toBe(true);
		expect(row("b", "pwd", "y").render(60)[0].startsWith(PANEL)).toBe(true);

		head.handleMouse(mouse("click", 0));
		expect(head.render(60).map(strip)).toEqual(["Ran 2 shell commands"]);
	});

	it("leaves a click on a card to pi, which expands that row", () => {
		const { model, groups, row } = setup();
		model.load([{ type: "message", message: assistant("a") }]);
		groups.toggle("a", false);
		const head = row("a", "ls", "x");
		head.render(60);
		expect(head.handleMouse(mouse("click", 1))).toBeUndefined();
	});
});

describe("standalone cards", () => {
	it("draw normally while their run is open", () => {
		const { model, row } = setup();
		model.agentStart();
		model.addMessage(assistant("a"));
		expect(strip(row("a", "ls", "x").render(60)[0])).toBe("● Bash(ls)");
	});

	it("draw normally with grouping off", () => {
		const { model, row } = setup({ groupRuns: false });
		model.load([{ type: "message", message: assistant("a", "b") }]);
		expect(strip(row("b", "pwd", "y").render(60)[0])).toBe("● Bash(pwd)");
	});

	it("say a click works too when folded", () => {
		const { row } = setup({ groupRuns: false, collapsedLines: 1 });
		const lines = row("a", "seq 3", "1\n2\n3").render(60).map(strip);
		expect(lines.some((l) => l.includes("… +2 lines (click or ctrl+o)"))).toBe(true);
	});

	it("sit on the panel when expanded, and on nothing when collapsed", () => {
		const { row } = setup({ groupRuns: false });
		expect(row("a", "ls", "x", { expanded: true }).render(60).every((l) => l.startsWith(PANEL))).toBe(true);
		expect(row("b", "ls", "x").render(60).some((l) => l.startsWith("\x1b[48"))).toBe(false);
	});

	it("keep compact mode to one line", () => {
		const { row } = setup({ groupRuns: false, toolMode: "compact" });
		expect(row("a", "ls", "x").render(60).map(strip)).toEqual(["● Bash(ls) · x"]);
	});
});

describe("backgrounds", () => {
	it("derive a panel from the theme's colours when its panel slot is the terminal default", () => {
		const { row } = setup({ groupRuns: false });
		const systemTheme = { ...theme, getBgAnsi: () => "\x1b[49m" };
		const r = cardRenderers("bash", {
			config: () => ({ ...DEFAULTS, groupRuns: false }),
			highlight: (code) => code.split("\n"),
			languageOf: () => undefined,
			expandKey: () => "ctrl+o",
		});
		const context: RenderContextLike = { args: { command: "ls" }, toolCallId: "z", state: {}, cwd: "/", expanded: true, isPartial: false, isError: false };
		r.renderResult?.({ content: [{ type: "text", text: "x" }] }, { expanded: true, isPartial: false }, systemTheme, context);
		const lines = (r.renderCall?.(context.args, systemTheme, context) as { render(w: number): string[] }).render(40);
		expect(lines.every((l) => l.startsWith("\x1b[48;2;"))).toBe(true);
		expect(row("a", "ls", "x", { expanded: true }).render(40)[0].startsWith(PANEL)).toBe(true);
	});
});

describe("hover", () => {
	it("highlights the card under the pointer in a colour of its own, until the pointer leaves", () => {
		const { hover, row, repaints } = setup({ groupRuns: false });
		const card = row("a", "ls", "x", { expanded: true });
		card.render(60);
		expect(card.handleMouse(mouse("move", 0))).toEqual({ handled: true, render: true });
		expect(card.handleMouse(mouse("move", 1))).toEqual({ handled: true, render: false });
		const lit = card.render(60);
		expect(lit.every((l) => l.startsWith("\x1b[48;2;"))).toBe(true);
		expect(lit[0].startsWith(PANEL)).toBe(false);

		hover.settle();
		hover.settle();
		expect(repaints()).toBe(1);
		expect(card.render(60)[0].startsWith(PANEL)).toBe(true);
	});

	it("highlights a run's line apart from its cards", () => {
		const { model, groups, hover, row } = setup();
		model.load([{ type: "message", message: assistant("a") }]);
		groups.toggle("a", false);
		const head = row("a", "ls", "x");
		head.render(60);
		head.handleMouse(mouse("move", 0));
		expect(hover.isHovered("run:a")).toBe(true);
		const lines = head.render(60);
		expect(lines[0].startsWith("\x1b[48;2;")).toBe(true);
		expect(lines[1].startsWith(PANEL)).toBe(true);
		head.handleMouse(mouse("move", 1));
		expect(hover.isHovered("card:a")).toBe(true);
	});
});
