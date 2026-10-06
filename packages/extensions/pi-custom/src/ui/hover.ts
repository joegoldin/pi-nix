// The hover highlight: which card or run line is under the mouse pointer.
//
// pi sends a "move" event only to the component under the pointer, so a card
// learns when the pointer arrives but never when it leaves for prose, the
// prompt or empty space. Leaving is inferred instead: every pointer report the
// terminal sends either reaches a card, which claims it, or it does not, and
// then nothing is under the pointer any more.
//
// That needs to see the raw reports, and ctx.ui.onTerminalInput cannot: in
// fullscreen, pi's own viewport listener is registered first (in TuiAltScreen's
// constructor) and consumes every mouse report before an extension's listener
// runs. So index.ts watches stdin itself, alongside pi's reader, and settles on
// the next macrotask, by which time pi has dispatched the report whichever
// listener ran first: a complete report is dispatched synchronously from the
// same stdin data event.

export interface HoverOwner {
	key: string;
	/** Repaints the owner's row; pi's render context supplies it. */
	repaint(): void;
}

export class HoverTracker {
	private owner: HoverOwner | undefined;
	private claimed = false;

	isHovered(key: string): boolean {
		return this.owner?.key === key;
	}

	/** A card under the pointer claims the report. Returns whether the highlight moved, so the caller repaints. */
	claim(key: string, repaint: () => void): boolean {
		this.claimed = true;
		if (this.owner?.key === key) {
			this.owner.repaint = repaint;
			return false;
		}
		this.owner = { key, repaint };
		return true;
	}

	/** After a pointer report has been dispatched: no claim means the pointer left every card. */
	settle(): void {
		const owner = this.owner;
		if (!this.claimed && owner) {
			this.owner = undefined;
			owner.repaint();
		}
		this.claimed = false;
	}

	clear(): void {
		this.owner = undefined;
		this.claimed = false;
	}
}

// SGR mouse reports: ESC [ < button ; col ; row M|m.
const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

/**
 * Whether a chunk of terminal input moves the pointer relative to the
 * transcript: motion (button bit 32) or a wheel step (bit 64), which scrolls
 * something else under a pointer that stays put.
 */
export function movesPointer(data: string): boolean {
	for (const m of data.matchAll(SGR_MOUSE)) {
		const button = Number(m[1]);
		if ((button & 32) !== 0 || (button & 64) !== 0) return true;
	}
	return false;
}
