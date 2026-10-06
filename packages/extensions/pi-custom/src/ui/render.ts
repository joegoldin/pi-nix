// The tool-renderer resolver: which calls get a card, and how pi's two render
// slots are turned into one.
//
// pi draws a call through renderCall and its result through renderResult, as
// two components stacked in the same row. A Claude Code card is one unit, and
// compact mode needs the header and the result on the SAME line, which two
// stacked components cannot express. So the call slot draws the whole card and
// the result slot only records what it was given. Both renderers run on every
// update before anything is painted, and the card reads that record at paint
// time, so it always sees the result of the update it is painting.
//
// The call slot is also where a row folds into its run (group.ts): the run's
// first row draws the run's line, the rest draw nothing, and pi drops a row
// that draws nothing entirely. pi hands mouse events to the call slot before
// its own click-to-expand, so the run's line takes clicks for the run and
// every row reports the pointer for the hover highlight.

import {
	backgroundAnsi,
	type Color,
	mixColors,
	type TerminalColorMode,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { CardComponent, type CardLayout, paint, type UiTheme } from "./card.ts";
import type { UiConfig } from "./config.ts";
import { type GroupState, planRow, type RowPlan, type RunModel, runSummary, type ToolRun } from "./group.ts";
import type { HoverTracker } from "./hover.ts";
import { BUILT_IN_TOOLS, buildCard, type CardDeps, type ToolResultLike } from "./tools.ts";

/** What renderResult leaves for the card. Lives in pi's per-row renderer state. */
interface RowRecord {
	result?: ToolResultLike;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
}

/** The fields of pi's ToolRenderContext this module reads. */
export interface RenderContextLike {
	args: unknown;
	toolCallId: string;
	state: { piUi?: RowRecord };
	cwd: string;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	/** Repaints this row; pi's context always has it, test contexts may not. */
	invalidate?(): void;
}

/** The run model and the state of its view, shared by every row. */
export interface RunsDeps {
	model: RunModel;
	groups: GroupState;
	/** pi's global ctrl+o state, which every run follows until clicked. */
	toolsExpanded(): boolean;
}

export interface RendererDeps {
	config(): UiConfig;
	highlight: CardDeps["highlight"];
	languageOf: CardDeps["languageOf"];
	/** The key that expands tool output, as pi shows it: "ctrl+o". */
	expandKey(): string;
	diff?: CardDeps["diff"];
	/** What a write call's target held before it ran; see index.ts. */
	priorContent?(toolCallId: string): string | null | undefined;
	runs?: RunsDeps;
	hover?: HoverTracker;
	/** Told how to make pi repaint, for changes made outside a render, such as a run closing. */
	noteRepaint?(repaint: () => void): void;
}

/** The slice of pi's Theme the backgrounds come from; test themes have none of it. */
interface ThemeColoursLike {
	getBgAnsi?(slot: "toolPendingBg"): string;
	colors?: Readonly<Record<string, Color>>;
	getColorMode?(): TerminalColorMode;
}

interface Backgrounds {
	key: string;
	panel?: string;
	hover?: string;
}

// The panel is toolPendingBg, the one background slot themes keep a neutral
// grey (dark okhsl(229 5% 24%), light okhsl(248 3% 91%)); the other slots carry
// a meaning in their tint: blue selection, green success, red error, violet
// custom messages. The theme has no slot for hover, so it is the panel moved
// toward the text colour: lighter on a dark theme, darker on a light one, so it
// stands apart from the panel and the terminal background either way.
//
// pi's system theme leaves every panel on the terminal's default background
// when the terminal reports no colours. The theme still has a concrete guess
// for that background, so the panel is then mixed from it the same way, by
// enough to show: mixing is perceptual, and a step of a tenth from black is
// still black to the eye.
const HOVER_MIX = 0.14;
const PANEL_MIX = 0.22;
const DEFAULT_BG = "\x1b[49m";
let backgroundCache: Backgrounds | undefined;

function backgroundsFor(theme: UiTheme): Omit<Backgrounds, "key"> {
	const t = theme as UiTheme & ThemeColoursLike;
	if (typeof t.getBgAnsi !== "function") return {};
	const slot = t.getBgAnsi("toolPendingBg");
	const mode = t.getColorMode?.();
	const base = t.colors?.toolPendingBg;
	const text = t.colors?.text;
	const key = `${slot}|${mode}|${base ? JSON.stringify(base) : ""}`;
	if (backgroundCache?.key === key) return backgroundCache;
	if (!base || !text || !mode) {
		backgroundCache = { key, panel: slot === DEFAULT_BG ? undefined : slot, hover: undefined };
		return backgroundCache;
	}
	const mixed = (amount: number) => backgroundAnsi(mixColors(base, text, amount), mode);
	const concrete = slot !== DEFAULT_BG;
	backgroundCache = {
		key,
		panel: concrete ? slot : mixed(PANEL_MIX),
		hover: mixed(concrete ? HOVER_MIX : PANEL_MIX + HOVER_MIX),
	};
	return backgroundCache;
}

const STANDALONE: RowPlan = { card: true, inPanel: false };

/** Nothing to paint; the result's content is drawn by the call slot. */
const EMPTY = { render: () => [] as string[], invalidate() {} };

class LiveCard {
	/** Rows the run's line takes at the top, which take clicks for the run rather than the card. */
	private headerRows = 0;
	private run: ToolRun | undefined;

	constructor(
		private toolName: string,
		private context: RenderContextLike,
		private theme: UiTheme,
		private deps: RendererDeps,
	) {}

	private get repaint(): () => void {
		return () => this.context.invalidate?.();
	}

	private runs(config: UiConfig): RunsDeps | undefined {
		return config.groupRuns ? this.deps.runs : undefined;
	}

	render(width: number): string[] {
		const config = this.deps.config();
		const w = Math.max(1, width);
		const runs = this.runs(config);
		if (this.context.invalidate) this.deps.noteRepaint?.(this.repaint);
		const plan = runs
			? planRow(runs.model, this.context.toolCallId, (run) => runs.groups.isExpanded(run.id, runs.toolsExpanded()))
			: STANDALONE;
		const backgrounds = backgroundsFor(this.theme);

		const rows: string[] = [];
		this.run = plan.header;
		if (plan.header) {
			const line = truncateToWidth(runSummary(plan.header, this.theme), w, "…");
			const hovered = this.deps.hover?.isHovered(`run:${plan.header.id}`) && backgrounds.hover;
			rows.push(hovered ? paint(line, w, hovered) : line);
		}
		this.headerRows = rows.length;
		if (plan.card) rows.push(...this.card(config, plan.inPanel, backgrounds, w));
		return rows;
	}

	private card(config: UiConfig, inPanel: boolean, backgrounds: Omit<Backgrounds, "key">, width: number): string[] {
		const record = this.context.state.piUi;
		const model = buildCard(
			{
				toolName: this.toolName,
				args: (this.context.args ?? {}) as Record<string, unknown>,
				result: record?.result,
				isPartial: record?.isPartial ?? true,
				isError: record?.isError ?? false,
				cwd: this.context.cwd,
				prior: this.deps.priorContent?.(this.context.toolCallId),
			},
			{ theme: this.theme, config, highlight: this.deps.highlight, languageOf: this.deps.languageOf, diff: this.deps.diff },
		);
		const expanded = record?.expanded ?? this.context.expanded;
		const hovered = this.deps.hover?.isHovered(`card:${this.context.toolCallId}`);
		const layout: CardLayout = {
			mode: config.toolMode === "compact" ? "compact" : "on",
			expanded,
			collapsedLines: config.collapsedLines,
			expandedLines: config.expandedLines,
			expandHint: this.theme.fg("muted", `(click or ${this.deps.expandKey()})`),
			background: hovered ? backgrounds.hover : expanded || inPanel ? backgrounds.panel : undefined,
		};
		return new CardComponent(model, layout, this.theme).render(width);
	}

	/**
	 * The pointer over this row claims the hover; a click on the run's line
	 * opens or folds the run. A click on the card itself is left to pi, which
	 * expands that one row.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const onHeader = event.y < this.headerRows && this.run !== undefined;
		if (event.type === "move" && this.deps.hover) {
			const key = onHeader && this.run ? `run:${this.run.id}` : `card:${this.context.toolCallId}`;
			return { handled: true, render: this.deps.hover.claim(key, this.repaint) };
		}
		const runs = this.runs(this.deps.config());
		if (event.type === "click" && event.button === "left" && onHeader && this.run && runs) {
			runs.groups.toggle(this.run.id, runs.toolsExpanded());
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {}
}

export interface ToolRenderersLike {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: any, context: any) => any;
	renderResult?: (result: any, options: any, theme: any, context: any) => any;
}

export function cardRenderers(toolName: string, deps: RendererDeps): ToolRenderersLike {
	return {
		renderShell: "self",
		renderCall: (_args, theme, context: RenderContextLike) => new LiveCard(toolName, context, theme, deps),
		renderResult: (result, options: { expanded: boolean; isPartial: boolean }, _theme, context: RenderContextLike) => {
			context.state.piUi = {
				result,
				isPartial: options.isPartial,
				isError: context.isError,
				expanded: options.expanded,
			};
			return EMPTY;
		},
	};
}

/**
 * The resolver pi calls for every tool name. Built-in tools always get a card,
 * whoever registered them. Other tools keep renderers of their own (a subagent
 * or todo tool draws something a card would flatten) and only get the generic
 * card when they have none, which is every MCP tool.
 */
export function createResolver(deps: RendererDeps) {
	return (toolName: string, next: () => ToolRenderersLike | undefined): ToolRenderersLike | undefined => {
		if (deps.config().toolMode === "off") return next();
		if (BUILT_IN_TOOLS.has(toolName)) return cardRenderers(toolName, deps);
		const theirs = next();
		if (theirs?.renderCall || theirs?.renderResult) return theirs;
		return cardRenderers(toolName, deps);
	};
}
