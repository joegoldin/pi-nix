// The prompt shown while a chord is half-typed.
//
// A two-key chord with no feedback is a memory test: you press the prefix, the
// screen does not change, and the only way to know it registered is to guess
// the second key correctly inside the timeout. Guess slowly and the prefix
// expires and the letter lands in the prompt, which reads as the feature being
// broken rather than as a chord that timed out.
//
// So the reader's pending state gets drawn. Plain rows rather than a component:
// pi's setWidget takes string[] and renders it below the editor without moving
// focus, and focus is the one thing this must not take -- the chord reader
// needs the next raw keystroke.

/** Rows for the key the reader is waiting on. */
export function hintRows(stage: "prefix" | "append"): string[] {
	if (stage === "append") {
		return ["pi-extras  append to register:  0-9  a numbered slot   ·   s  the stash   ·   esc  cancel"];
	}
	return [
		"pi-extras  s stash   ·   u undo   ·   r redo   ·   y copy   ·   d cut   ·   t thinking   ·   a append…   ·   esc cancel",
	];
}
