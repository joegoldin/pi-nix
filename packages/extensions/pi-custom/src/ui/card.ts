// The Claude Code tool card: one header line naming the call, then the result
// hanging off a ⎿ elbow.
//
//   ● Read(src/index.ts)
//     ⎿  Read 120 lines (ctrl+o to expand)
//
// Every tool renderer builds a CardModel and hands it here, so the layout rules
// live in one place: how the header truncates, how the body collapses, and what
// compact mode keeps. The renderers only decide what to say.
//
// A collapsed card is a summary, so its rows are clipped. An expanded card is
// for reading, so its rows wrap, and it sits on a panel background so it reads
// as one block apart from the prose around it.

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolMode } from "./config.ts";

/** The slice of pi's Theme the cards use, declared structurally so tests can pass a recorder. */
export interface UiTheme {
	fg(slot: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}

export type CardState = "pending" | "success" | "error";

export interface CardModel {
	/** The verb, e.g. "Read" or "Bash". */
	title: string;
	/** What it acted on, shown in parentheses after the title. */
	target?: string;
	/** Qualifiers after the target, dimmed: "offset 10, limit 40". */
	detail?: string;
	state: CardState;
	/** One themed line describing the result. */
	summary?: string;
	/** Themed body rows, shown under the summary. A function when the rows depend on the
	 *  width left after the gutter, as a side-by-side diff does. */
	body?: string[] | ((width: number) => string[]);
	/** Rows the producer already dropped before building body, so the count stays honest. */
	omitted?: number;
	/** Keep the last rows rather than the first: command output ends with what matters. */
	tail?: boolean;
}

export interface CardLayout {
	mode: Exclude<ToolMode, "off">;
	expanded: boolean;
	collapsedLines: number;
	expandedLines: number;
	/** The hint after a collapsed card's count, already themed: "(click or ctrl+o)" from the live keybinding. */
	expandHint: string;
	/** An SGR background opener to paint every row with, edge to edge: the panel an open card sits on. */
	background?: string;
	/**
	 * The pointer is over the card. Like Claude Code, hover brightens the grey
	 * "… +N lines" text to the text colour rather than painting a background:
	 * a background across the card is what an open card looks like.
	 */
	hovered?: boolean;
}

const BULLET = "●";
const ELBOW = "⎿";
const HEAD_INDENT = "  ";
// The elbow row and the rows under it share a gutter, so body text lines up
// with the summary rather than with the elbow.
const ELBOW_PREFIX = `${HEAD_INDENT}${ELBOW}  `;
const BODY_PREFIX = " ".repeat(visibleWidth(ELBOW_PREFIX));
/** The gutter width body rows sit behind, for renderers that size their own columns. */
export const BODY_GUTTER = visibleWidth(BODY_PREFIX);

function bulletColour(state: CardState): string {
	return state === "error" ? "error" : state === "success" ? "success" : "muted";
}

export function header(model: CardModel, theme: UiTheme): string {
	let text = `${theme.fg(bulletColour(model.state), BULLET)} ${theme.bold(model.title)}`;
	if (model.target !== undefined || model.detail !== undefined) {
		const inner = [model.target, model.detail ? theme.fg("dim", model.detail) : undefined]
			.filter((part) => part !== undefined && part !== "")
			.join(" ");
		text += `(${inner})`;
	}
	return text;
}

function fit(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

// Resets that would end the background part way along a row: a full reset and
// the default-background code theme.bg closes with.
const BG_RESET = /\x1b\[(?:0?|49)m/g;

/** Paint a row's background across the full width, surviving the resets inside it. */
export function paint(line: string, width: number, background: string): string {
	const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	return `${background}${padded.replace(BG_RESET, (reset) => reset + background)}\x1b[49m`;
}

/** Lay a card out at a given width: clipped when collapsed, wrapped when expanded. */
export function layoutCard(model: CardModel, layout: CardLayout, theme: UiTheme, width: number): string[] {
	const w = Math.max(1, width);
	const rows = layoutRows(model, layout, theme, w);
	const background = layout.background;
	return background ? rows.map((row) => paint(row, w, background)) : rows;
}

function plural(n: number): string {
	return n === 1 ? "line" : "lines";
}

function layoutRows(model: CardModel, layout: CardLayout, theme: UiTheme, w: number): string[] {
	if (layout.mode === "compact" && !layout.expanded) {
		// Without a summary, the body's most telling line stands in: the last
		// for a tail card such as command output, the first otherwise.
		const rows = Array.isArray(model.body) ? model.body : [];
		const said = model.summary ?? (model.tail ? rows.at(-1) : rows[0]);
		const summary = said ? ` ${theme.fg("dim", "·")} ${said}` : "";
		return [fit(header(model, theme) + summary, w)];
	}

	// One logical line as rows: clipped to one row, or wrapped with the rest
	// under the same gutter.
	const place = (first: string, rest: string, line: string): string[] => {
		if (!layout.expanded) return [fit(first + line, w)];
		const gutter = Math.max(visibleWidth(first), visibleWidth(rest));
		return wrapTextWithAnsi(line, Math.max(1, w - gutter)).map((part, i) => fit((i === 0 ? first : rest) + part, w));
	};

	const rows: string[] = place("", HEAD_INDENT, header(model, theme));
	const grey = layout.hovered ? "text" : "muted";
	const body = typeof model.body === "function" ? model.body(Math.max(1, w - BODY_GUTTER)) : (model.body ?? []);
	const limit = layout.expanded ? layout.expandedLines : layout.collapsedLines;
	const shown = model.tail ? body.slice(Math.max(0, body.length - limit)) : body.slice(0, limit);
	const capped = body.length - shown.length;
	const hidden = capped + (model.omitted ?? 0);
	// Expanded, a remainder is the view's limit, not a fold: say so, so a
	// truncated card never reads as one that only needs another click.
	const more =
		hidden === 0
			? undefined
			: !layout.expanded
				? `${theme.fg(grey, `… +${hidden} ${plural(hidden)}`)} ${layout.expandHint}`
				: capped > 0
					? theme.fg(grey, `… ${hidden} more ${plural(hidden)} not shown (expanded view limit)`)
					: theme.fg(grey, `… +${hidden} ${plural(hidden)}`);

	const lines: string[] = [];
	if (model.summary) lines.push(model.summary);
	if (more && model.tail) lines.push(more);
	lines.push(...shown);
	if (more && !model.tail) lines.push(more);

	lines.forEach((line, i) => {
		rows.push(...place(i === 0 ? theme.fg("muted", ELBOW_PREFIX) : BODY_PREFIX, BODY_PREFIX, line));
	});
	return rows;
}

/** The pi Component wrapper. It re-lays out on every render because width is only known then. */
export class CardComponent {
	constructor(
		private model: CardModel,
		private layout: CardLayout,
		private theme: UiTheme,
	) {}

	render(width: number): string[] {
		return layoutCard(this.model, this.layout, this.theme, width);
	}

	invalidate(): void {}
}
