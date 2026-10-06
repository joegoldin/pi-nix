// The Claude Code tool card: one header line naming the call, then the result
// hanging off a ⎿ elbow.
//
//   ● Read(src/index.ts)
//     ⎿  Read 120 lines (ctrl+o to expand)
//
// Every tool renderer builds a CardModel and hands it here, so the layout rules
// live in one place: how the header truncates, how the body collapses, and what
// compact mode keeps. The renderers only decide what to say.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
	/** The "to expand" hint, already themed; pi supplies it from the live keybinding. */
	expandHint: string;
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

/** Lay a card out at a given width. Every row is clipped, never wrapped: a card is a summary. */
export function layoutCard(model: CardModel, layout: CardLayout, theme: UiTheme, width: number): string[] {
	const w = Math.max(1, width);

	if (layout.mode === "compact" && !layout.expanded) {
		// Without a summary, the body's most telling line stands in: the last
		// for a tail card such as command output, the first otherwise.
		const rows = Array.isArray(model.body) ? model.body : [];
		const said = model.summary ?? (model.tail ? rows.at(-1) : rows[0]);
		const summary = said ? ` ${theme.fg("dim", "·")} ${said}` : "";
		return [fit(header(model, theme) + summary, w)];
	}

	const rows: string[] = [fit(header(model, theme), w)];
	const body = typeof model.body === "function" ? model.body(Math.max(1, w - BODY_GUTTER)) : (model.body ?? []);
	const limit = layout.expanded ? layout.expandedLines : layout.collapsedLines;
	const shown = model.tail ? body.slice(Math.max(0, body.length - limit)) : body.slice(0, limit);
	const hidden = body.length - shown.length + (model.omitted ?? 0);
	const more =
		hidden > 0
			? `${theme.fg("muted", `… +${hidden} ${hidden === 1 ? "line" : "lines"}`)}${layout.expanded ? "" : ` ${layout.expandHint}`}`
			: undefined;

	const lines: string[] = [];
	if (model.summary) lines.push(model.summary);
	if (more && model.tail) lines.push(more);
	lines.push(...shown);
	if (more && !model.tail) lines.push(more);

	lines.forEach((line, i) => {
		rows.push(fit(`${i === 0 ? theme.fg("muted", ELBOW_PREFIX) : BODY_PREFIX}${line}`, w));
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
