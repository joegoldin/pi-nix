// The menu shown while a chord is half-typed.
//
// A two-key chord with no feedback is a memory test: you press the prefix, the
// screen does not change, and the only way to know it registered is to guess
// the second key correctly inside the timeout.
//
// An overlay, and it took two tries to get one that behaves. pi's inline TUI
// composites overlays into its own rendered lines and grows the drawn region to
// reach them -- `minLinesNeeded = max(lines, row + overlayHeight)` in pi-tui's
// compositeOverlays. The default anchor is `center` and `row` is resolved
// against the terminal height, so a centred menu in a forty-row terminal padded
// twenty blank lines under the prompt to reach the middle. That is not the
// overlay's fault, it is the anchor's: pinned to the top, `row` is zero, the
// menu is composited over lines the TUI was drawing anyway, and nothing is
// padded at all.

/** The subset of pi's Theme this overlay uses, declared structurally so the
 *  tests can pass a recorder in place of the real proxy. */
export interface HintTheme {
	fg(slot: string, text: string): string;
}

interface RenderHost {
	requestRender(): void;
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
export function renderHint(_stage: HintStage, width: number, theme: HintTheme): string[] {
	const rows = [theme.fg("toolTitle", "Prompt stash")];
	for (const [key, label] of ENTRIES) {
		rows.push(`  ${theme.fg("accent", key.padEnd(4))}${theme.fg("text", label)}`);
	}
	rows.push(theme.fg("muted", "  esc   cancel"));
	// width is part of the Component contract and the caller sizes the box; no
	// row here is long enough to wrap, so truncating would only lose a label.
	void width;
	return rows;
}

/**
 * The overlay component pi's ctx.ui.custom mounts. Structural rather than an
 * implementation of pi-tui's Component: pi injects that package as a jiti
 * virtual module, so importing it would break `bun test`.
 */
export function createHintComponent(
	tui: RenderHost,
	theme: HintTheme,
	stage: () => HintStage,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
	return {
		render: (width: number) => renderHint(stage(), width, theme),
		handleInput: () => {
			// Deliberately nothing. pi-tui consults input listeners before the
			// focused component, so the chord reader has already taken every key
			// that means anything here.
		},
		invalidate: () => {
			tui.requestRender();
		},
	};
}
