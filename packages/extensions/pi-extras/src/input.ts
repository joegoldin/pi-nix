// Transforms on the prompt text itself: the thinking-level cycle the ctrl+s t
// chord walks, and the `@path` references pi's autocomplete puts in the input.

/**
 * The levels ctrl+s t walks. pi's ThinkingLevel also has "minimal" and "max";
 * five steps is what fits in a chord that has to be pressed repeatedly, and the
 * two omitted levels stay reachable through pi's own /thinking.
 */
export const THINKING_CYCLE = ["off", "low", "medium", "high", "xhigh"] as const;

export type CycleLevel = (typeof THINKING_CYCLE)[number];

/** A level outside the cycle restarts it rather than guessing a neighbour. */
export function nextThinkingLevel(current: string | undefined): CycleLevel {
	const index = THINKING_CYCLE.indexOf(current as CycleLevel);
	if (index === -1) return "off";
	return THINKING_CYCLE[(index + 1) % THINKING_CYCLE.length] as CycleLevel;
}

export interface PathRef {
	/** The reference as typed, at sign included. */
	token: string;
	path: string;
	start: number;
	end: number;
}

/** An at sign glued to the preceding word is an email address or a decorator,
 *  never a reference, so the match must start the line or follow whitespace. */
const REF = /(^|\s)@(\S+)/g;

/** Sentence punctuation a path almost never ends in, and prose often does. */
const TRAILING = /[,;:.]+$/;

export function findPathRefs(text: string): PathRef[] {
	const refs: PathRef[] = [];
	REF.lastIndex = 0;
	for (let match = REF.exec(text); match !== null; match = REF.exec(text)) {
		const path = (match[2] as string).replace(TRAILING, "");
		if (path === "") continue;
		const start = match.index + (match[1] as string).length;
		refs.push({ token: `@${path}`, path, start, end: start + path.length + 1 });
	}
	return refs;
}

function absolute(path: string, cwd: string, homeDir: string): string {
	if (path.startsWith("~/")) return `${homeDir}/${path.slice(2)}`;
	if (path.startsWith("/")) return path;
	return `${cwd}/${path}`;
}

/**
 * Rewrite `@~/x` to an absolute path. pi resolves a relative reference against
 * the cwd on its own but leaves the tilde alone, which hands the agent a
 * directory literally named "~".
 */
export function expandPathRefs(text: string, homeDir: string): string {
	const refs = findPathRefs(text).filter((ref) => ref.path.startsWith("~/"));
	let out = text;
	// Right to left, so an earlier ref's offsets survive a later rewrite.
	for (const ref of refs.reverse()) {
		out = `${out.slice(0, ref.start)}@${homeDir}/${ref.path.slice(2)}${out.slice(ref.end)}`;
	}
	return out;
}

/** The references that point at nothing, for a warning the user can act on. */
export function unresolvedRefs(
	text: string,
	cwd: string,
	homeDir: string,
	exists: (path: string) => boolean,
): string[] {
	const missing: string[] = [];
	for (const ref of findPathRefs(text)) {
		if (missing.includes(ref.token)) continue;
		try {
			if (!exists(absolute(ref.path, cwd, homeDir))) missing.push(ref.token);
		} catch {
			// A path this process cannot stat is not a path the user mistyped.
		}
	}
	return missing;
}
