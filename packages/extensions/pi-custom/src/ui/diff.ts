// Edit and write diffs, drawn from the display diff pi's edit tool already
// returns in details.diff.
//
// That string is pi's own format, not a unified patch: one row per line, a sign
// column, the line number padded to a fixed width, then the text.
//
//   -12 const a = 1;
//   +12 const a = 2;
//    13 return a;
//        ...
//
// Context rows carry the OLD line number, added rows the new one, removed rows
// the old one; a row of only "..." marks skipped context. Parsing it rather than
// re-diffing keeps the card identical to what the model was told changed.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UiTheme } from "./card.ts";
import type { DiffLayout } from "./config.ts";

export type DiffRowKind = "add" | "del" | "ctx" | "skip";

export interface DiffRow {
	kind: DiffRowKind;
	/** The number pi printed: new for add, old for del and ctx, none for skip. */
	line?: number;
	text: string;
}

const ROW = /^([+\- ])\s*(\d+) ?(.*)$/;
const SKIP = /^ \s*\.\.\.$/;

export function parseDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	for (const raw of diff.split("\n")) {
		if (raw === "") continue;
		if (SKIP.test(raw)) {
			rows.push({ kind: "skip", text: "" });
			continue;
		}
		const m = ROW.exec(raw);
		if (!m) continue;
		const kind: DiffRowKind = m[1] === "+" ? "add" : m[1] === "-" ? "del" : "ctx";
		rows.push({ kind, line: Number(m[2]), text: m[3] ?? "" });
	}
	return rows;
}

export function countChanges(rows: DiffRow[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const row of rows) {
		if (row.kind === "add") added++;
		else if (row.kind === "del") removed++;
	}
	return { added, removed };
}

const SIGN: Record<DiffRowKind, string> = { add: "+", del: "-", ctx: " ", skip: " " };
const COLOUR: Record<DiffRowKind, string> = {
	add: "toolDiffAdded",
	del: "toolDiffRemoved",
	ctx: "toolDiffContext",
	skip: "muted",
};

function numberWidth(rows: DiffRow[]): number {
	return Math.max(1, ...rows.map((r) => String(r.line ?? "").length));
}

function clip(text: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** One side's cell: number, sign, text, coloured as a unit so the change reads at a glance. */
function cell(row: DiffRow | undefined, numW: number, width: number, theme: UiTheme): string {
	if (!row) return " ".repeat(width);
	if (row.kind === "skip") return pad(theme.fg("muted", `${" ".repeat(numW)} ⋯`), width);
	const num = theme.fg("dim", String(row.line ?? "").padStart(numW));
	const body = `${SIGN[row.kind]} ${row.text.replace(/\t/g, "  ")}`;
	const textW = width - numW - 1;
	return pad(`${num} ${theme.fg(COLOUR[row.kind], clip(body, textW))}`, width);
}

export function renderUnified(rows: DiffRow[], width: number, theme: UiTheme): string[] {
	const numW = numberWidth(rows);
	return rows.map((row) => cell(row, numW, width, theme).trimEnd());
}

/**
 * Side by side: context on both sides, a removed run against the added run that
 * replaced it. Runs are paired row for row; the longer run hangs below with an
 * empty cell opposite, which is what a reader expects from a replacement.
 */
export function renderSplit(rows: DiffRow[], width: number, theme: UiTheme): string[] {
	const numW = numberWidth(rows);
	const sep = theme.fg("dim", " │ ");
	const colW = Math.max(numW + 4, Math.floor((width - visibleWidth(sep)) / 2));
	const out: string[] = [];
	// pi numbers context rows by the old file, so the new side's number is the
	// old one shifted by every addition and removal above it.
	let shift = 0;
	let i = 0;
	while (i < rows.length) {
		const row = rows[i];
		if (row.kind === "ctx" || row.kind === "skip") {
			const right = row.line === undefined ? row : { ...row, line: row.line + shift };
			out.push(`${cell(row, numW, colW, theme)}${sep}${cell(right, numW, colW, theme)}`.trimEnd());
			i++;
			continue;
		}
		const dels: DiffRow[] = [];
		const adds: DiffRow[] = [];
		while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
		while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
		shift += adds.length - dels.length;
		for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
			out.push(`${cell(dels[k], numW, colW, theme)}${sep}${cell(adds[k], numW, colW, theme)}`.trimEnd());
		}
	}
	return out;
}

export function renderDiffRows(
	rows: DiffRow[],
	layout: DiffLayout,
	splitMinWidth: number,
	width: number,
	theme: UiTheme,
): string[] {
	const split = layout === "split" || (layout === "auto" && width >= splitMinWidth);
	return split ? renderSplit(rows, width, theme) : renderUnified(rows, width, theme);
}
