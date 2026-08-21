// The menu shown while a chord is half-typed.
//
// A two-key chord with no feedback is a memory test: you press the prefix, the
// screen does not change, and the only way to know it registered is to guess
// the second key correctly inside the timeout.
//
// A widget rather than an overlay, and the overlay was tried first. pi's inline
// TUI composites overlays into its own rendered lines and grows the drawn
// region to reach them: `minLinesNeeded = max(lines, row + overlayHeight)`
// (pi-tui's compositeOverlays). The default anchor is `center`, and `row` is
// resolved against the terminal height, so a nine-row menu in a forty-row
// terminal padded twenty blank lines under the prompt to get there. It was not
// overlaying anything -- there is no alt-screen under an inline session to
// float above -- it was pushing the session down the terminal.
//
// A widget is one row, adjacent to the prompt, and costs nothing when it is
// not there. It does not take focus either, which suits a reader that needs
// the next raw keystroke.
//
// The earlier claim that a widget could not survive here was wrong. The menu
// really did vanish, but the cause was the chord completing itself on a key
// release, not the statusline's re-render; with that fixed, the widget holds
// through four ticks of it.

/** One row for the key the reader is waiting on. */
export function hintRows(stage: "prefix" | "append"): string[] {
	if (stage === "append") {
		return ["pi-extras  append to register:   0-9  a numbered slot   ·   s  the stash   ·   esc  cancel"];
	}
	return [
		"pi-extras  s stash   ·   u undo   ·   r redo   ·   y copy   ·   d cut   ·   t thinking   ·   a append…   ·   esc cancel",
	];
}
