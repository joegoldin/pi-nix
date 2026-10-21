import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";

export type SelectionRow = { line: string; start: number; end: number; skip?: boolean };
type Point = { row: number; col: number; boundary?: boolean; scrollView?: unknown };
type Bounds = { start: Point; end: Point };
type Rect = { x: number; y: number; width: number; height: number };
type Box = { component: unknown; rect: Rect; clip: Rect; children: Box[] };
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
		const box = this.currentLayout && findBox(this.currentLayout.root, current.component);
		if (!bounds || bounds.start.scrollView || !box) return original.call(this);
		const rows = current.rows();
		const result: string[] = [];
		let changed = false;
		for (let row = bounds.start.row; row <= bounds.end.row; row++) {
			const line = this.previousScreen[row] ?? "";
			const columns = this.getSelectionColumns(line, row, bounds);
			const source = rows.get(row - box.rect.y);
			// Check the displayed row too: an overlay may cover the editor without
			// removing its underlying layout box. Never strip another component.
			if (source && row >= box.clip.y && row < box.clip.y + box.clip.height && columns.start >= box.rect.x && columns.end <= box.rect.x + box.rect.width && stripTerminalSequences(sliceByColumn(line, box.rect.x, box.rect.width, true)) === stripTerminalSequences(source.line)) {
				changed = true;
				if (source.skip) continue;
				columns.start = Math.max(columns.start, box.rect.x + source.start);
				columns.end = Math.min(columns.end, box.rect.x + source.end);
			}
			result.push(stripTerminalSequences(sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true)).trimEnd());
		}
		if (!changed) return original.call(this);
		return result.join("\n") || undefined;
	};
	return true;
}
