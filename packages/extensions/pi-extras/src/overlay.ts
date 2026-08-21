// The stash overlay: the saved drafts, and the four things you can do to one.
//
// Layout is decided on plain text and the theme is applied afterwards, the same
// way pi-voice's widget does it. A theme is free to encode a colour however it
// likes, so measuring its output would make a row's width a property of the
// colour encoding rather than of the text.

import { isKeyRelease } from "./chord.ts";
import { filterEntries, windowFor } from "./filter.ts";

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
	| { kind: "startFilter" }
	| { kind: "filterChar"; char: string }
	| { kind: "filterBackspace" }
	| { kind: "endFilter" }
	| { kind: "noop" }
	| { kind: "close" };

/**
 * Up and down, in every encoding a terminal might send them in.
 *
 * A table of literal bytes is not enough. pi asks for Kitty keyboard protocol
 * flags 7, and flag 2 reports press and release for every key, which moves
 * functional keys off their legacy form: Up stops being `\x1b[A` and becomes
 * `\x1b[1;1:1A`, with the release as `\x1b[1;1:3A`. Letters are unaffected --
 * a text-producing key still sends its text on press -- which is why `j` and
 * `k` kept working in the list while the arrows silently did nothing.
 *
 * So the parameters are matched rather than enumerated: optional numbers,
 * semicolons and colons between the CSI and the final letter, plus the SS3 form
 * an application-cursor-keys terminal uses.
 */
const ARROW = /^\x1b(?:\[[\d;:]*|O)([ABCD])$/;

function arrowCommand(data: string): OverlayCommand | undefined {
	const match = ARROW.exec(data);
	if (!match) return undefined;
	switch (match[1]) {
		case "A":
			return { kind: "move", delta: -1 };
		case "B":
			return { kind: "move", delta: 1 };
		default:
			// Left and right are not bound, but they must still be swallowed:
			// letting them through would type into the prompt behind the list.
			return { kind: "noop" };
	}
}

/**
 * Enter, escape and backspace, normalised back to the byte the tables use.
 *
 * The same protocol that moves the arrows moves these: with event types on,
 * escape arrives as `\x1b[27;1:1u` rather than `\x1b`. Mapping them back keeps
 * one table instead of two encodings of every binding.
 */
const NAMED_CSI_U = /^\x1b\[(\d+)(?:[:;][\d:;]*)?u$/;
const NAMED: Record<string, string> = { "13": "\r", "27": "\x1b", "127": "\x7f" };

function namedKey(data: string): string | undefined {
	const match = NAMED_CSI_U.exec(data);
	return match ? NAMED[match[1] as string] : undefined;
}

const KEYS: Record<string, OverlayCommand> = {
	k: { kind: "move", delta: -1 },
	j: { kind: "move", delta: 1 },
	"\r": { kind: "restore" },
	"\n": { kind: "restore" },
	r: { kind: "restore" },
	y: { kind: "copy" },
	d: { kind: "delete" },
	D: { kind: "clearAll" },
	q: { kind: "close" },
	"/": { kind: "startFilter" },
	"\x1b": { kind: "close" },
	"\x03": { kind: "close" },
};

/** The keys that mean the same thing whether or not a filter is being typed. */
const FILTER_KEYS: Record<string, OverlayCommand> = {
	"\r": { kind: "restore" },
	"\n": { kind: "restore" },
	"\x7f": { kind: "filterBackspace" },
	"\x08": { kind: "filterBackspace" },
	"\x1b": { kind: "endFilter" },
	"\x03": { kind: "close" },
};

/**
 * The key's meaning, which depends on whether a filter is open.
 *
 * Single letters cannot be both commands and query text, and this list binds
 * seven of them. So filtering is a mode: `/` opens it, printable keys go to the
 * query while it is open, escape leaves it, and the commands are themselves
 * again afterwards. Movement and restore work in both, because they are the two
 * things you want while narrowing a list.
 */
export function overlayCommand(data: string, filtering = false): OverlayCommand | undefined {
	// Releases would otherwise be read as a second press of the same key.
	if (isKeyRelease(data)) return { kind: "noop" };
	const arrow = arrowCommand(data);
	if (arrow) return arrow;
	const named = namedKey(data);
	if (named) return filtering ? (FILTER_KEYS[named] ?? undefined) : KEYS[named];
	if (!filtering) return KEYS[data];
	const shared = FILTER_KEYS[data];
	if (shared) return shared;
	// One printable character, which excludes control codes and escape runs.
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 0x20 && code !== 0x7f) return { kind: "filterChar", char: data };
	}
	return undefined;
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

const HELP = "enter restore · y copy · d delete · D clear all · / filter · esc close";
const FILTER_HELP = "type to narrow · enter restore · esc leave the filter";

/** How many entry rows the list draws before it starts scrolling. */
export const VISIBLE_ROWS = 10;

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
	filter = "",
	filtering = false,
	windowTop = 0,
): string[] {
	const rows: string[] = [theme.fg("toolTitle", "Stash")];

	if (filtering || filter !== "") {
		// The caret separates "typing a query" from "a query is still narrowing
		// this list", which is exactly what the key bindings turn on.
		rows.push(theme.fg("accent", previewOf(`filter: ${filter}${filtering ? "\u2588" : ""}`, width)));
	}

	const matches = filterEntries(entries, filter);
	if (entries.length === 0) {
		rows.push(theme.fg("muted", "  the stash is empty"));
	} else if (matches.length === 0) {
		rows.push(theme.fg("warning", "  nothing matches that"));
	} else {
		const top = windowFor(matches.length, selected, VISIBLE_ROWS, windowTop);
		matches.slice(top, top + VISIBLE_ROWS).forEach((entry, offset) => {
			const isSelected = top + offset === selected;
			const marker = isSelected ? "\u25b8" : " ";
			const preview = previewOf(entry.text, Math.max(0, width - 4));
			const text = `${marker} ${preview}`;
			rows.push(isSelected ? theme.fg("accent", text) : theme.fg("text", text));
		});
		if (matches.length > VISIBLE_ROWS || matches.length !== entries.length) {
			rows.push(theme.fg("dim", `  ${matches.length} of ${entries.length} shown`));
		}
	}

	if (!persistent) rows.push(theme.fg("warning", "  memory only: the stash file could not be written"));
	rows.push(theme.fg("dim", previewOf(filtering ? FILTER_HELP : HELP, width)));
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
	let filter = "";
	let filtering = false;
	let windowTop = 0;

	/** The entries the list is actually showing, which is what `selected`
	 *  indexes. Restoring and deleting have to translate back to the stash's
	 *  own index or a filtered list would act on the wrong draft. */
	const visible = () => filterEntries(actions.entries(), filter);

	const run = (command: OverlayCommand): void => {
		const rows = visible();
		const target = rows[selected]?.index;
		switch (command.kind) {
			case "move":
				selected = clampIndex(selected + command.delta, rows.length);
				windowTop = windowFor(rows.length, selected, VISIBLE_ROWS, windowTop);
				break;
			case "restore":
				if (target !== undefined) actions.restore(target);
				done();
				return;
			case "copy":
				if (target !== undefined) actions.copy(target);
				break;
			case "delete":
				if (target !== undefined) actions.remove(target);
				// The list shrinks under the cursor, so re-clamp against what is
				// left rather than against what was there.
				selected = clampIndex(selected, visible().length);
				windowTop = windowFor(visible().length, selected, VISIBLE_ROWS, windowTop);
				break;
			case "clearAll":
				actions.clearAll();
				selected = 0;
				filter = "";
				filtering = false;
				windowTop = 0;
				break;
			case "startFilter":
				filtering = true;
				break;
			case "filterChar":
				filter += command.char;
				selected = 0;
				windowTop = 0;
				break;
			case "filterBackspace":
				filter = filter.slice(0, -1);
				selected = 0;
				windowTop = 0;
				break;
			case "endFilter":
				// Leaves the query in place: escape stops typing, and a second
				// escape -- now that the commands are themselves again -- closes.
				filtering = false;
				break;
			case "noop":
				// Swallowed on purpose: a release, or an arrow with nothing bound
				// to it. Either would reach the prompt behind the list otherwise.
				return;
			case "close":
				done();
				return;
		}
		tui.requestRender();
	};

	return {
		render: (width: number) =>
			renderStash(actions.entries(), selected, width, actions.persistent(), theme, filter, filtering, windowTop),
		handleInput: (data: string) => {
			const command = overlayCommand(data, filtering);
			if (command) run(command);
		},
		invalidate: () => {
			tui.requestRender();
		},
	};
}
