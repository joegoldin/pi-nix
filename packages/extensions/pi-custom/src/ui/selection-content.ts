import { Box, Container, Markdown, MouseRegion, Text, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Framed } from "./frame.ts";

export type CopyRow = { line: string; start: number; text: string; owner: object; id: number; before: string; skip?: boolean };
type Rows = (CopyRow | undefined)[];
type NativeText = { text: string; paddingX: number; paddingY: number; cachedLines?: string[]; cachedWidth?: number; theme: ConstructorParameters<typeof Markdown>[3]; defaultTextStyle?: ConstructorParameters<typeof Markdown>[4]; options: NonNullable<ConstructorParameters<typeof Markdown>[5]>; cachedTokens?: WeakRef<{ source: string }> };
const cache = new WeakMap<object, WeakRef<{ lines: string[]; rows: Rows | undefined }>>();
const plain = (text: string) => stripTerminalSequences(text);

/** Match actual rendered fragments against logical text; never infer wrapping from a full-width row. */
export function mapRows(owner: object, lines: string[], logical: string[], paddingX: number, paddingY: number): Rows | undefined {
	const rows: Rows = lines.map(line => ({ line, start: 0, text: "", owner, id: -1, before: "", skip: true }));
	let id = 0, offset = 0;
	for (let row = paddingY; row < lines.length - paddingY; row++) {
		const source = logical[id];
		if (source === undefined) return;
		const body = plain(sliceByColumn(lines[row]!, paddingX, Math.max(0, visibleWidth(lines[row]!) - paddingX * 2), true)).trimEnd();
		// Hanging list/quote indentation is renderer-owned. Only remove it if
		// the remaining fragment matches the source without skipping any words.
		const candidates = offset ? [body, body.trimStart(), body.replace(/^(?:\s*│\s*)+/, "")] : [body];
		let found: { text: string; at: number; prefix: number } | undefined;
		for (const text of candidates) {
			const at = source.indexOf(text, offset);
			if (at >= offset && /^\s*$/.test(source.slice(offset, at)) && (text || !source.trim())) {
				found = { text, at, prefix: visibleWidth(body.slice(0, body.length - text.length)) }; break;
			}
		}
		if (!found) return;
		const end = found.at + found.text.length;
		const finished = !source.slice(end).trim();
		rows[row] = { line: lines[row]!, start: paddingX + found.prefix, text: source.slice(found.at, finished ? undefined : end), owner, id, before: source.slice(offset, found.at) };
		if (finished) { id++; offset = 0; } else offset = end;
	}
	return id === logical.length ? rows : undefined;
}

function textRows(component: Text | Markdown, expectedWidth: number): Rows | undefined {
	// Pinned native renderer caches provide the exact visible rows. A separate
	// Markdown instance supplies unwrapped formatting without mutating live layout.
	const native = component as unknown as NativeText;
	const lines = native.cachedLines, width = native.cachedWidth;
	if (!lines || width !== expectedWidth) return;
	const previous = cache.get(component)?.deref();
	if (previous?.lines === lines) return previous.rows;
	let logical: string[] | undefined;
	let paddingX = native.paddingX;
	if (component instanceof Text) {
		paddingX = Math.min(paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		logical = plain(native.text.replace(/\t/g, "   ")).split(/\r\n|\r|\n/);
	} else {
		const renderedSource = native.cachedTokens?.deref()?.source;
		if (native.options.transform && renderedSource === undefined) return;
		const source = renderedSource ?? native.text;
		const sourceLines = source.split("\n");
		const wide = sourceLines.reduce((max, line) => Math.max(max, visibleWidth(line)), width) + 64;
		// Copying must not allocate a huge padded rectangle for giant logs.
		if (wide <= 16_384 && wide * (sourceLines.length + 4) <= 2_000_000) {
			const copy = new Markdown(source, 0, 0, native.theme, native.defaultTextStyle, { ...native.options, transform: undefined });
			logical = copy.render(wide).map(line => plain(line).trimEnd());
		}
	}
	const rows = logical ? mapRows(component, lines, logical, paddingX, native.paddingY) : undefined;
	cache.set(component, new WeakRef({ lines, rows }));
	return rows;
}

/** Walk the native mouse layout: it already records child heights and padding at the last render. */
export function contentRows(component: object, width: number): Rows | undefined {
	const provided = component as { getSelectionRows?(width: number): Rows | undefined };
	if (typeof provided.getSelectionRows === "function") return provided.getSelectionRows(width);
	if (component instanceof Text || component instanceof Markdown) return textRows(component, width);
	if (component instanceof MouseRegion) return contentRows((component as unknown as { child: object }).child, width);
	if (component instanceof Framed) {
		const layout = component.getSelectionLayout();
		if (!layout || layout.width !== Math.max(6, width) - 4) return;
		const inner = contentRows(layout.component, layout.width);
		return layout.lines.map((line, row) => {
			if (!row || row === layout.lines.length - 1) return { line, start: 0, text: "", owner: component, id: -1, before: "", skip: true };
			const source = inner?.[row - 1];
			const displayed = plain(sliceByColumn(line, 2, layout.width, true)).trimEnd();
			return source && plain(source.line).trimEnd() === displayed
				? { ...source, line, start: source.start + 2 }
				: { line, start: 2, text: displayed, owner: component, id: row, before: "" };
		});
	}
	const native = component as { mouseLayout?: { width: number; children: { component: object; height: number }[] }; paddingX?: number; paddingY?: number; cache?: { lines: string[] }; selfRenderContainer?: object; selfRenderHeight?: number; getRenderShell?(): string };
	if (native.getRenderShell?.() === "self" && native.selfRenderContainer && native.selfRenderHeight) {
		return [undefined, ...(contentRows(native.selfRenderContainer, width) ?? Array(native.selfRenderHeight).fill(undefined))];
	}
	if (!(component instanceof Container) && !(component instanceof Box)) return;
	const layout = native.mouseLayout;
	if (!layout || layout.width !== (component instanceof Box ? Math.max(1, width - native.paddingX! * 2) : width)) return;
	const rows: Rows = [];
	const paddingX = component instanceof Box ? native.paddingX! : 0;
	const paddingY = component instanceof Box ? native.paddingY! : 0;
	for (let i = 0; i < paddingY; i++) rows.push(undefined);
	for (const child of layout.children) {
		const childRows = contentRows(child.component, layout.width);
		for (let row = 0; row < child.height; row++) {
			const source = childRows?.[row];
			rows.push(source ? { ...source, start: source.start + paddingX, line: native.cache?.lines[rows.length] ?? source.line } : undefined);
		}
	}
	for (let i = 0; i < paddingY; i++) rows.push(undefined);
	return rows;
}

export function copyContentRows(lines: readonly string[], rows: Rows, startRow: number, endRow: number, columnsFor: (line: string, row: number) => { start: number; end: number }): { text: string | undefined } | undefined {
	const result: string[] = [];
	let previous: CopyRow | undefined, changed = false;
	for (let row = startRow; row <= endRow; row++) {
		const line = lines[row] ?? "", source = rows[row];
		const columns = columnsFor(line, row);
		if (source && plain(source.line).trimEnd() === plain(line).trimEnd()) {
			changed = true;
			if (source.skip) continue;
			const start = Math.max(columns.start, source.start);
			const end = Math.min(columns.end, source.start + visibleWidth(source.text));
			if (end <= start && source.text) { previous = undefined; continue; }
			const text = sliceByColumn(source.text, start - source.start, Math.max(0, end - start), true);
			if (previous?.owner === source.owner && previous.id === source.id && result.length) result[result.length - 1] += source.before + text;
			else result.push(text);
			previous = source;
		} else {
			result.push(plain(sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true)).trimEnd());
			previous = undefined;
		}
	}
	return changed ? { text: result.join("\n") || undefined } : undefined;
}
