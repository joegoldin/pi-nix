import type { EditorBase } from "./editor.ts";

type Cursor = { line: number; col: number };
type Snapshot = { text: string; cursor: Cursor };
// Pi's TypeScript-private editing methods are ordinary prototype methods. Keep
// this adapter narrow and exercise it against the real packaged CustomEditor.
export type PasteEditorBase = new (...args: any[]) => InstanceType<EditorBase> & {
	handlePaste(text: string): void;
	getText(): string;
	setText(text: string): void;
	getCursor(): Cursor;
	pasteCounter: number;
	pastes: Map<number, string>;
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	lastAction: unknown;
	cancelAutocomplete(): void;
	exitHistoryBrowsing(): void;
	pushUndoSnapshot(): void;
	setCursorCol(col: number): void;
	insertTextAtCursorInternal(text: string): void;
};

export function createRepeatPasteEditor(Base: PasteEditorBase): PasteEditorBase {
	return class RepeatPasteEditor extends Base {
		private repeatedPaste?: { raw: string; id: number; marker: string; collapsed: Snapshot; expanded?: Snapshot };

		override setText(text: string): void {
			this.repeatedPaste = undefined;
			super.setText(text);
		}

		private snapshot(): Snapshot { return { text: this.getText(), cursor: this.getCursor() }; }
		private matches(snapshot: Snapshot | undefined): boolean {
			const cursor = this.getCursor();
			return !!snapshot && snapshot.text === this.getText() && snapshot.cursor.line === cursor.line && snapshot.cursor.col === cursor.col;
		}

		override handlePaste(raw: string): void {
			const previous = this.repeatedPaste;
			if (previous?.raw === raw) {
				if (this.matches(previous.expanded)) return;
				const content = this.pastes.get(previous.id);
				if (content !== undefined && this.matches(previous.collapsed)) {
					this.cancelAutocomplete();
					this.exitHistoryBrowsing();
					this.pushUndoSnapshot();
					this.lastAction = null;
					const { line, col } = this.getCursor();
					const start = col - previous.marker.length;
					const text = this.state.lines[line]!;
					this.state.lines[line] = text.slice(0, start) + text.slice(col);
					this.setCursorCol(start);
					this.pastes.delete(previous.id);
					// Expanded source may literally contain another paste's marker.
					// Move conflicting IDs, rather than changing or reinterpreting text.
					const occupied = [this.getText(), content, ...this.pastes.values()].join("\n");
					for (const [id, value] of [...this.pastes]) {
						const pattern = new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
						if (!content.match(pattern)) continue;
						do { this.pasteCounter++; } while (occupied.includes(`[paste #${this.pasteCounter}`));
						const replace = (text: string) => text.replace(pattern, (marker) => marker.replace(`#${id}`, `#${this.pasteCounter}`));
						const cursor = this.getCursor();
						const prefix = replace(this.state.lines[cursor.line]!.slice(0, cursor.col));
						this.state.lines = this.state.lines.map(replace);
						this.setCursorCol(prefix.length);
						this.pastes.delete(id);
						this.pastes.set(this.pasteCounter, value);
					}
					this.insertTextAtCursorInternal(content);
					previous.expanded = this.snapshot();
					return;
				}
			}
			const counter = this.pasteCounter;
			super.handlePaste(raw);
			this.repeatedPaste = undefined;
			if (this.pasteCounter === counter) return;
			const { line, col } = this.getCursor();
			const marker = this.state.lines[line]!.slice(0, col).match(/\[paste #\d+(?: \+\d+ lines| \d+ chars)?\]$/)?.[0];
			if (marker) this.repeatedPaste = { raw, id: this.pasteCounter, marker, collapsed: this.snapshot() };
		}
	};
}
