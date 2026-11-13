import { CURSOR_MARKER, isKeyRelease, matchesKey, renderFakeCursor, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { PasteEditorBase } from "./repeat-paste.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ANIMATION_MS = 80;

type LayoutLine = { text: string; hasCursor: boolean; cursorPos?: number };
export type DictationColour = (slot: "text" | "dim" | "success" | "warning" | "error" | "provisional" | "shimmer", text: string) => string;
export interface DictationUpdate { committed: string; partial: string; level: number; processing?: boolean }
export interface DictationHandle {
	update(value: DictationUpdate): void;
	finish(text?: string): void;
}
export interface DictationRequest {
	accept(handle: DictationHandle): void;
	onInterrupt(): void;
	onCancel?(): void;
}

/** The event bus keeps voice optional and avoids replacing another extension's editor. */
export function registerDictationBridge(
	events: { on(channel: string, handler: (data: unknown) => void): () => void },
	editor: () => { beginDictation(onInterrupt: () => void, onCancel?: () => void): DictationHandle } | undefined,
): void {
	events.on("pi-voice:begin", data => {
		if (!data || typeof data !== "object") return;
		const request = data as Partial<DictationRequest>;
		if (typeof request.accept !== "function" || typeof request.onInterrupt !== "function") return;
		const target = editor();
		if (target) request.accept(target.beginDictation(request.onInterrupt, request.onCancel));
	});
}

type DictationBase = new (...args: any[]) => InstanceType<PasteEditorBase> & {
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	layoutText(width: number): LayoutLine[];
	onChange?: (text: string) => void;
};

function clean(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
}

/** Keep streamed revisions in one insertion/undo unit, without paste placeholders. */
export function createDictationEditor(Base: DictationBase, colour: DictationColour) {
	return class DictationEditor extends Base {
		private dictation?: DictationUpdate & {
			prefix: string; suffix: string; lastText: string; line: number; col: number;
			undoSaved: boolean; onInterrupt(): void; onCancel?(): void;
		};
		private drawingDictation = false;
		private meterColumns = new Map<number, number>();
		private redraw: () => void;
		private animation?: ReturnType<typeof setInterval>;
		private phase = 0;

		dictationMeterColumn(row: number): number | undefined { return this.meterColumns.get(row); }

		dictationExcludedColumns(line: number, start: number, length: number): number[] {
			if (!this.drawingDictation || line !== this.state.cursorLine) return [];
			const text = this.state.lines[line]!;
			return [this.state.cursorCol - 1, this.state.cursorCol]
				.filter(col => col >= start && col < start + length)
				.map(col => visibleWidth(text.slice(start, col)));
		}

		constructor(...args: any[]) {
			super(...args);
			this.redraw = () => args[0].requestRender();
		}

		beginDictation(onInterrupt: () => void, onCancel?: () => void): DictationHandle {
			this.interruptDictation();
			this.cancelAutocomplete();
			this.exitHistoryBrowsing();
			const { line, col } = this.getCursor();
			const text = this.getText();
			const at = this.state.lines.slice(0, line).reduce((n, row) => n + row.length + 1, 0) + col;
			const state = { committed: "", partial: "", level: 0, prefix: text.slice(0, at), suffix: text.slice(at), lastText: text, line, col, undoSaved: false, onInterrupt, onCancel, processing: false };
			this.dictation = state;
			this.phase = 0;
			this.redraw();
			const update = (value: DictationUpdate) => {
				if (this.dictation !== state) return;
				if (!this.ownsInsertion()) { this.interruptDictation(); return; }
				state.committed = clean(value.committed);
				state.partial = clean(value.partial);
				state.processing ||= value.processing ?? false;
				if (state.processing) this.startAnimation();
				state.level = Number.isFinite(value.level) ? Math.max(0, Math.min(1, value.level)) : 0;
				const speech = [state.committed, state.partial].filter(Boolean).join(" ");
				const beforeCursor = state.prefix + speech;
				const next = beforeCursor + state.suffix;
				if (next !== state.lastText) {
					if (!state.undoSaved) { this.pushUndoSnapshot(); state.undoSaved = true; }
					this.lastAction = null;
					this.state.lines = next.split("\n");
					const lines = beforeCursor.split("\n");
					this.state.cursorLine = state.line = lines.length - 1;
					this.setCursorCol(state.col = lines.at(-1)!.length);
					state.lastText = next;
					this.onChange?.(next);
				}
				this.redraw();
			};
			return {
				update,
				finish: (text) => {
					if (this.dictation !== state) return;
					if (text !== undefined) update({ committed: text, partial: "", level: state.level });
					if (this.dictation === state) { this.dictation = undefined; this.stopAnimation(); }
					this.redraw();
				},
			};
		}

		private ownsInsertion(): boolean {
			const state = this.dictation;
			const cursor = this.getCursor();
			return !!state && state.lastText === this.getText() && state.line === cursor.line && state.col === cursor.col;
		}

		private startAnimation(): void {
			if (this.animation) return;
			this.animation = setInterval(() => { this.phase++; this.redraw(); }, ANIMATION_MS);
			this.animation.unref?.();
		}

		private stopAnimation(): void {
			if (this.animation) clearInterval(this.animation);
			this.animation = undefined;
		}

		interruptDictation(): void {
			const state = this.dictation;
			this.dictation = undefined;
			this.stopAnimation();
			if (state) { (state.onCancel ?? state.onInterrupt)(); this.redraw(); }
		}

		override setText(text: string): void {
			this.interruptDictation();
			super.setText(text);
		}

		private stopDictation(): void {
			const state = this.dictation;
			if (!state || state.processing) return;
			state.processing = true;
			this.startAnimation();
			state.onInterrupt();
			this.redraw();
		}

		override handleInput(data: string): void {
			if (this.dictation) {
				if (isKeyRelease(data) || data === "\x1b[I" || data === "\x1b[O" || data === "") return;
				if (matchesKey(data, "ctrl+c")) this.interruptDictation();
				else this.stopDictation();
				// Keep ownership until the batch result arrives; no edit or submit
				// may race the replacement. Ctrl+C alone abandons that replacement.
				return;
			}
			super.handleInput(data);
		}

		override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (!this.dictation || event.type !== "click" || event.button !== "left") return super.handleMouse(event);
			this.stopDictation();
			return { handled: true };
		}

		private withMeterCell<T>(run: () => T): T {
			const saved = this.state;
			const lines = [...saved.lines];
			const line = lines[saved.cursorLine]!;
			lines[saved.cursorLine] = line.slice(0, saved.cursorCol) + "  " + line.slice(saved.cursorCol);
			this.state = { ...saved, lines, cursorCol: saved.cursorCol + 1 };
			try { return run(); } finally { this.state = saved; }
		}

		override layoutText(width: number): LayoutLine[] {
			const rows = super.layoutText(width);
			const state = this.dictation;
			if (!this.drawingDictation || !state) return rows;
			const start = state.prefix.length;
			const end = start + state.committed.length + state.partial.length + (state.committed && state.partial ? 1 : 0);
			const paint = (text: string, offset: number) => {
				let result = "", run = "", previous: "provisional" | "shimmer" | undefined;
				// Colour whole graphemes, never split emoji or combining sequences.
				for (const { segment, index } of graphemes.segment(text)) {
					const at = offset + index;
					const slot = at < start || at >= end ? undefined
						: state.processing && ((at - start - this.phase) % 28 + 28) % 28 < 5 ? "shimmer" : "provisional";
					if (slot !== previous) {
						result += previous ? colour(previous, run) : run;
						run = "";
						previous = slot;
					}
					run += segment;
				}
				return result + (previous ? colour(previous, run) : run);
			};
			const text = this.getText();
			let offset = 0;
			return rows.map(row => {
				const start = offset;
				offset += row.text.length;
				if (text[offset] === "\n") offset++;
				if (row.hasCursor && row.cursorPos !== undefined) {
					const before = paint(row.text.slice(0, row.cursorPos), start);
					return { ...row, text: before + paint(row.text.slice(row.cursorPos), start + row.cursorPos), cursorPos: before.length };
				}
				return { ...row, text: paint(row.text, start) };
			});
		}

		override render(width: number): string[] {
			this.meterColumns.clear();
			if (this.dictation && !this.ownsInsertion()) this.interruptDictation();
			const state = this.dictation;
			if (!state) return super.render(width);
			const bar = "▁▂▃▄▅▆▇█"[Math.max(0, Math.ceil(state.level * 8) - 1)]!;
			const slot = state.level >= 0.85 ? "error" : state.level >= 0.6 ? "warning" : "success";
			const meter = state.processing ? colour("shimmer", "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[this.phase % 10]!) : colour(slot, bar);
			const padding = Math.min(super.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
			// Native word-wrap cannot split a wide grapheme into a single cell.
			// At such tiny widths keep only the meter, without touching the draft.
			if (width - padding * 2 - (padding ? 0 : 1) < 2) return width > 0 ? [meter] : [];
			// Give the gap and meter their own cells, including in the middle
			// of a draft. Native wrapping/scrolling still owns all layout decisions.
			this.drawingDictation = true;
			try {
				return this.withMeterCell(() => super.render(width).map((row, index) => {
					const cursor = row.indexOf(renderFakeCursor(" "));
					if (cursor >= 0) this.meterColumns.set(index, visibleWidth(row.slice(0, cursor)));
					return row.replaceAll(CURSOR_MARKER, "").replace(renderFakeCursor(" "), meter);
				}));
			} finally {
				this.drawingDictation = false;
			}
		}
	};
}
