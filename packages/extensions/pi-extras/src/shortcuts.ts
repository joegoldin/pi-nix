// The panel ctrl+? draws: every key this extension binds, in one place.
//
// It stops there rather than reaching for pi's own keybindings and every other
// extension's. pi does not expose either to extension code -- the aggregate
// used by its own `/hotkeys` command (KeybindingsManager for built-ins,
// ExtensionRunner.getShortcuts() for the rest) lives on interactive-mode's
// private state, not on the ExtensionContext this file receives. The nearest
// thing extension code is handed to a KeybindingsManager is the third
// parameter of ctx.ui.custom()'s factory, and reaching for that here would
// mean mounting a component just to read a value off it -- for a widget, that
// is the overlay/editor-replacement bug this whole extension exists to avoid,
// reintroduced to answer a question about keybindings.
//
// So this tells the truth about what it is: pi-extras' own bindings, plus a
// pointer to the command that actually has the rest, sourced from pi itself
// and therefore unable to go stale the way a copy kept here would.

export interface ShortcutsTheme {
	fg(slot: string, text: string): string;
}

const ROWS: ReadonlyArray<readonly [string, string]> = [
	["ctrl+s", "stash, or bring the last one back"],
	["ctrl+g s", "stash"],
	["ctrl+g u", "unstash"],
	["ctrl+g U", "unstash all"],
	["ctrl+g l", "list"],
	["ctrl+g c", "copy"],
	["ctrl+g x", "cut"],
];

export function renderShortcuts(theme: ShortcutsTheme): string[] {
	// pi caps a string-array widget at ten lines (InteractiveMode.MAX_WIDGET_
	// LINES) and truncates silently past it -- past tense, it truncated the
	// close instruction off the bottom of exactly this panel. One title, seven
	// bindings, the /hotkeys pointer, the close instruction: ten.
	const rows = [theme.fg("toolTitle", "pi-extras shortcuts")];
	for (const [keys, label] of ROWS) {
		rows.push(`  ${theme.fg("accent", keys.padEnd(10))}${theme.fg("text", label)}`);
	}
	rows.push(
		`  ${theme.fg("accent", "/hotkeys".padEnd(10))}${theme.fg("text", "everything else: built-ins, every extension")}`,
	);
	rows.push(theme.fg("muted", "  any key closes this"));
	return rows;
}
