// The menu shown while a chord is half-typed.
//
// A two-key chord with no feedback is a memory test: you press the prefix, the
// screen does not change, and the only way to know it registered is to guess
// the second key correctly inside the timeout.
//
// Drawn as a widget above the editor, which is the only surface that puts it
// where it belongs: at the end of the chat log, against the prompt whose keys
// it names. An overlay cannot be put there. pi's inline TUI grows its drawn
// region to `row + overlayHeight`, and every anchor resolves `row` against the
// terminal rather than against the session -- centred, it padded twenty blank
// rows to reach the middle; anchored to the bottom, it sat on the terminal
// floor with the whole gap above it. A widget has no coordinates to get wrong.
//
// Multi-row, because that was the other half of the complaint. setWidget takes
// a string[], so the menu is a list with a title, not a line of keys crammed
// end to end.

/** The subset of pi's Theme this overlay uses, declared structurally so the
 *  tests can pass a recorder in place of the real proxy. */
export interface HintTheme {
	fg(slot: string, text: string): string;
}

/** What the reader is waiting for. One stage now that the register step is gone. */
export type HintStage = "prefix";

const ENTRIES: ReadonlyArray<readonly [string, string]> = [
	["s", "stash"],
	["u", "unstash"],
	["U", "unstash all"],
	["l", "list"],
	["c", "copy"],
	["x", "cut"],
];

/** The menu body: a title, one row per key, and how to get out. */
export function renderHint(_stage: HintStage, theme: HintTheme): string[] {
	const rows = [theme.fg("toolTitle", "Prompt stash")];
	for (const [key, label] of ENTRIES) {
		rows.push(`  ${theme.fg("accent", key.padEnd(4))}${theme.fg("text", label)}`);
	}
	rows.push(theme.fg("muted", "  esc   cancel"));
	return rows;
}
