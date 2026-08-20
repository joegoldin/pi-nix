// The menu shown while a chord is half-typed.
//
// A two-key chord with no feedback is a memory test: you press the prefix, the
// screen does not change, and the only way to know it registered is to guess
// the second key correctly inside the timeout.
//
// An overlay rather than a widget, and the reason is ownership. Widgets land in
// a shared container, and agent-statusline draws every one of its rows inside a
// single one of those while re-rendering on a 1Hz tick, so a second widget is
// blanked within the second. An overlay is mounted by the TUI on its own,
// above everything, and stays until it is dismissed.
//
// It takes focus, which does not matter here: the chord reader runs on
// onTerminalInput, and pi-tui consults input listeners before the focused
// component (TUI.handleTerminalInput), so every chord key is consumed before
// this component is offered it. handleInput is a no-op for exactly that reason.

/** The subset of pi's Theme this overlay uses, declared structurally so the
 *  tests can pass a recorder in place of the real proxy. */
export interface HintTheme {
	fg(slot: string, text: string): string;
}

interface RenderHost {
	requestRender(): void;
}

/** What the reader is waiting for, which decides what the menu offers. */
export type HintStage = "prefix" | "append";

const PREFIX_ENTRIES: ReadonlyArray<readonly [string, string]> = [
	["s", "stash"],
	["u", "undo"],
	["r", "redo"],
	["y", "copy"],
	["d", "cut"],
	["t", "thinking"],
	["a", "append…"],
];

const APPEND_ENTRIES: ReadonlyArray<readonly [string, string]> = [
	["0-9", "numbered slot"],
	["s", "the stash"],
];

/** The menu body, themed. Title, one row per key, then how to get out. */
export function renderHint(stage: HintStage, width: number, theme: HintTheme): string[] {
	const title = stage === "append" ? "Append to register" : "Chord";
	const rows = [theme.fg("toolTitle", title)];
	for (const [key, label] of stage === "append" ? APPEND_ENTRIES : PREFIX_ENTRIES) {
		rows.push(`  ${theme.fg("accent", key.padEnd(4))}${theme.fg("text", label)}`);
	}
	rows.push(theme.fg("muted", "  esc  cancel"));
	// width is part of the Component contract and the caller's layout already
	// bounds this box; nothing here needs to wrap, so it is deliberately unused
	// rather than silently truncating a two-word label.
	void width;
	return rows;
}

/**
 * The overlay component pi's ctx.ui.custom mounts. Structural rather than an
 * implementation of pi-tui's Component: pi injects that package as a jiti
 * virtual module, so importing it would break `bun test`.
 *
 * `stage` is read on every render rather than captured, so the same mounted
 * overlay can follow the reader from the prefix step into the register step
 * without being torn down and rebuilt.
 */
export function createHintComponent(
	tui: RenderHost,
	theme: HintTheme,
	stage: () => HintStage,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
	return {
		render: (width: number) => renderHint(stage(), width, theme),
		handleInput: () => {
			// Deliberately nothing. Every key that means something to the chord
			// has already been consumed by the reader's input listener.
		},
		invalidate: () => {
			tui.requestRender();
		},
	};
}
