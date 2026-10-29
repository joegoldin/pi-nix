import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { contentRows, copyContentRows } from "./selection-content.ts";

export type SelectionRow = { line: string; start: number; end: number; skip?: boolean; excludeColumn?: number; source?: { id: number; text: string } };
type Point = { row: number; col: number; boundary?: boolean; scrollView?: unknown };
type Bounds = { start: Point; end: Point };
type Rect = { x: number; y: number; width: number; height: number };
type Box = { component: object; rect: Rect; clip: Rect; children: Box[]; lineOffset?: number; scrollContentLines?: readonly string[] };
type Owner = { component: unknown; rows: () => Map<number, SelectionRow> };
const OWNER = Symbol.for("pi-custom.prompt-selection");
// Fullscreen Pi owns selection; main-screen terminal selection cannot exclude
// drawn glyphs. This adapter is tested with the shipped TuiAltScreen, not mocks.
type SelectionTui = {
	[OWNER]?: Owner;
	getActiveSelectionText(): string | undefined;
	getSelectionBounds(): Bounds | undefined;
	getSelectionColumns(line: string, row: number, bounds: Bounds): { start: number; end: number };
	currentLayout?: { root: Box };
	previousScreen: string[];
};

function findBox(box: Box, component: unknown): Box | undefined {
	if (box.component === component) return box;
	for (const child of box.children) { const found = findBox(child, component); if (found) return found; }
	return undefined;
}

export function installPromptSelection(value: unknown, owner: Owner): boolean {
	const tui = value as SelectionTui;
	if (typeof tui.getActiveSelectionText !== "function" || typeof tui.getSelectionBounds !== "function" || typeof tui.getSelectionColumns !== "function") return false;
	if (tui[OWNER]) { tui[OWNER] = owner; return true; }
	tui[OWNER] = owner;
	const original = tui.getActiveSelectionText;
	tui.getActiveSelectionText = function () {
		const current = this[OWNER]!;
		const bounds = this.getSelectionBounds();
		if (!bounds) return original.call(this);
		if (bounds.start.scrollView && this.currentLayout) {
			const scroll = findBox(this.currentLayout.root, bounds.start.scrollView);
			const child = scroll?.children[0];
			const rows = child && contentRows(child.component, child.rect.width);
			const copied = rows && scroll?.scrollContentLines && copyContentRows(scroll.scrollContentLines, rows, bounds.start.row, bounds.end.row, (line, row) => this.getSelectionColumns(line, row, bounds));
			return copied ? copied.text : original.call(this);
		}
		const box = this.currentLayout && findBox(this.currentLayout.root, current.component);
		if (!box) return original.call(this);
		const rows = current.rows();
		const result: string[] = [];
		let changed = false;
		let previousSource: number | undefined;
		for (let row = bounds.start.row; row <= bounds.end.row; row++) {
			const line = this.previousScreen[row] ?? "";
			const columns = this.getSelectionColumns(line, row, bounds);
			const source = rows.get(row - box.rect.y + (box.lineOffset ?? 0));
			let excludeColumn: number | undefined;
			let sourceText: string | undefined;
			// Check the displayed row too: an overlay may cover the editor without
			// removing its underlying layout box. Never strip another component.
			if (source && row >= box.clip.y && row < box.clip.y + box.clip.height && columns.start >= box.rect.x && columns.end <= box.rect.x + box.rect.width && stripTerminalSequences(sliceByColumn(line, box.rect.x, box.rect.width, true)) === stripTerminalSequences(source.line)) {
				changed = true;
				if (source.skip) continue;
				columns.start = Math.max(columns.start, box.rect.x + source.start);
				columns.end = Math.min(columns.end, box.rect.x + source.end);
				if (source.excludeColumn !== undefined) excludeColumn = box.rect.x + source.excludeColumn;
				if (source.source) {
					const start = columns.start - box.rect.x - source.start;
					const end = columns.end - box.rect.x - source.start;
					const excluded = excludeColumn === undefined ? undefined : excludeColumn - box.rect.x - source.start;
					sourceText = excluded !== undefined && excluded >= start && excluded < end
						? sliceByColumn(source.source.text, start, excluded - start, true) + sliceByColumn(source.source.text, excluded + 1, end - excluded - 1, true)
						: sliceByColumn(source.source.text, start, Math.max(0, end - start), true);
					if (previousSource === source.source.id && result.length) result[result.length - 1] += sourceText;
					else result.push(sourceText);
					previousSource = source.source.id;
					continue;
				}
			}
			const selected = excludeColumn !== undefined && excludeColumn >= columns.start && excludeColumn < columns.end
				? sliceByColumn(line, columns.start, excludeColumn - columns.start, true) + sliceByColumn(line, excludeColumn + 1, columns.end - excludeColumn - 1, true)
				: sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true);
			result.push(stripTerminalSequences(selected).trimEnd());
			previousSource = undefined;
		}
		if (!changed) return original.call(this);
		return result.join("\n") || undefined;
	};
	return true;
}
