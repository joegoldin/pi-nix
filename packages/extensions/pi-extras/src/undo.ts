// Undo and redo for the editor's text, kept by this extension rather than by
// pi.
//
// pi's own tui.editor.undo works inside the editor component and knows nothing
// about the whole-buffer replacements the stash chords perform: restoring a
// draft or cutting the input is one setText call, which an editor-level undo
// sees as a single opaque change or not at all. This buffer records the text
// before each of those replacements, so ctrl+s u puts back exactly what was
// there.
//
// In memory only. An undo stack that outlived the session would offer to
// restore text from a conversation that no longer exists.

/** Deep enough to walk back through a session's worth of chords. */
export const MAX_HISTORY = 50;

export class UndoBuffer {
	private past: string[] = [];
	private future: string[] = [];

	/** Remember the text about to be replaced. */
	record(text: string): void {
		if (this.past[this.past.length - 1] === text) return;
		this.past.push(text);
		if (this.past.length > MAX_HISTORY) this.past.shift();
		this.future = [];
	}

	undo(current: string): string | undefined {
		const previous = this.past.pop();
		if (previous === undefined) return undefined;
		this.future.push(current);
		return previous;
	}

	redo(current: string): string | undefined {
		const next = this.future.pop();
		if (next === undefined) return undefined;
		this.past.push(current);
		return next;
	}
}
