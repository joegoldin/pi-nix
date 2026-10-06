// Filtering and windowing for the stash list.
//
// Kept apart from the renderer and from the component so both can be tested
// without a TUI: these are the two decisions the list makes on every keystroke,
// and they are the ones worth pinning.

/** One entry, with the position it holds in the unfiltered stash. */
export interface FilteredEntry {
	/** Index in the full list, which is also the register that reads it back. */
	index: number;
	text: string;
}

/**
 * Entries matching `query`, in stash order.
 *
 * Case-insensitive substring, over the whitespace-collapsed text. Not fuzzy:
 * a stash holds prompts, and a prompt is prose, so a subsequence match on prose
 * matches nearly everything and ranks it by accident.
 */
export function filterEntries(entries: readonly string[], query: string): FilteredEntry[] {
	const all = entries.map((text, index) => ({ index, text }));
	const needle = query.trim().toLowerCase();
	if (needle === "") return all;
	return all.filter((e) => e.text.replace(/\s+/g, " ").toLowerCase().includes(needle));
}

/**
 * The slice of `count` rows to draw, given the cursor and the room available.
 *
 * The window follows the cursor rather than paging: it moves by one when the
 * cursor steps off an edge, so a list scrolled to the middle stays where it was
 * while you look at it.
 */
export function windowFor(count: number, selected: number, height: number, previousTop = 0): number {
	if (count <= height || height <= 0) return 0;
	const maxTop = count - height;
	let top = Math.min(Math.max(previousTop, 0), maxTop);
	if (selected < top) top = selected;
	if (selected >= top + height) top = selected - height + 1;
	return Math.min(Math.max(top, 0), maxTop);
}
