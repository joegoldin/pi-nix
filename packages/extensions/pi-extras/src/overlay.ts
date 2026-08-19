// The stash overlay: the saved drafts, and the four things you can do to one.
//
// Layout is decided on plain text and the theme is applied afterwards, the same
// way pi-voice's widget does it. A theme is free to encode a colour however it
// likes, so measuring its output would make a row's width a property of the
// colour encoding rather than of the text.

const ELLIPSIS = "…";

/** The subset of pi's Theme this overlay uses, declared structurally so the
 *  tests can pass a recorder in place of the real proxy. */
export interface StashTheme {
	fg(slot: string, text: string): string;
}

export type OverlayCommand =
	| { kind: "move"; delta: number }
	| { kind: "restore" }
	| { kind: "copy" }
	| { kind: "delete" }
	| { kind: "clearAll" }
	| { kind: "close" };

const KEYS: Record<string, OverlayCommand> = {
	"\x1b[A": { kind: "move", delta: -1 },
	"\x1bOA": { kind: "move", delta: -1 },
	k: { kind: "move", delta: -1 },
	"\x1b[B": { kind: "move", delta: 1 },
	"\x1bOB": { kind: "move", delta: 1 },
	j: { kind: "move", delta: 1 },
	"\r": { kind: "restore" },
	"\n": { kind: "restore" },
	r: { kind: "restore" },
	y: { kind: "copy" },
	d: { kind: "delete" },
	D: { kind: "clearAll" },
	q: { kind: "close" },
	"\x1b": { kind: "close" },
	"\x03": { kind: "close" },
};

export function overlayCommand(data: string): OverlayCommand | undefined {
	return KEYS[data];
}

/** Selection wraps, because a ten-row list is faster to reach from either end. */
export function clampIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	return ((index % count) + count) % count;
}

/** One row's worth of a draft: the first thing the user would recognise. */
export function previewOf(text: string, width: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat === "") return width >= 7 ? "(blank)" : "";
	if (width <= 0) return "";
	const chars = [...flat];
	if (chars.length <= width) return flat;
	return `${chars.slice(0, Math.max(0, width - 1)).join("")}${ELLIPSIS}`;
}

const HELP = "enter restore · y copy · d delete · D clear all · esc close";

/**
 * Render the whole overlay. `persistent` is false once the stash has fallen
 * back to memory, which the user has to be told: those drafts are gone at the
 * end of the session.
 */
export function renderStash(
	entries: readonly string[],
	selected: number,
	width: number,
	persistent: boolean,
	theme: StashTheme,
): string[] {
	const rows: string[] = [theme.fg("toolTitle", "Stash")];

	if (entries.length === 0) {
		rows.push(theme.fg("muted", "  the stash is empty"));
	} else {
		entries.forEach((entry, index) => {
			// The row number is the register that reads it back, so the overlay
			// doubles as the reference for ctrl+s a <n>.
			const marker = index === selected ? "▸" : " ";
			const preview = previewOf(entry, Math.max(0, width - 5));
			const text = `${marker} ${index} ${preview}`;
			rows.push(index === selected ? theme.fg("accent", text) : theme.fg("text", text));
		});
	}

	if (!persistent) rows.push(theme.fg("warning", "  memory only: the stash file could not be written"));
	rows.push(theme.fg("dim", previewOf(HELP, width)));
	return rows;
}

/** What the overlay component can do to the stash it is showing. */
export interface StashOverlayActions {
	entries(): readonly string[];
	persistent(): boolean;
	restore(index: number): void;
	copy(index: number): void;
	remove(index: number): void;
	clearAll(): void;
}

interface RenderHost {
	requestRender(): void;
}

/**
 * The overlay component pi's ctx.ui.custom mounts. Structural rather than an
 * implementation of pi-tui's Component: pi injects that package as a jiti
 * virtual module, so importing it would break `bun test`.
 */
export function createStashComponent(
	tui: RenderHost,
	theme: StashTheme,
	actions: StashOverlayActions,
	done: () => void,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
	let selected = 0;

	const run = (command: OverlayCommand): void => {
		const count = actions.entries().length;
		switch (command.kind) {
			case "move":
				selected = clampIndex(selected + command.delta, count);
				break;
			case "restore":
				if (count > 0) actions.restore(selected);
				done();
				return;
			case "copy":
				if (count > 0) actions.copy(selected);
				break;
			case "delete":
				if (count > 0) actions.remove(selected);
				selected = clampIndex(selected, actions.entries().length);
				break;
			case "clearAll":
				actions.clearAll();
				selected = 0;
				break;
			case "close":
				done();
				return;
		}
		tui.requestRender();
	};

	return {
		render: (width: number) => renderStash(actions.entries(), selected, width, actions.persistent(), theme),
		handleInput: (data: string) => {
			const command = overlayCommand(data);
			if (command) run(command);
		},
		invalidate: () => {
			tui.requestRender();
		},
	};
}
