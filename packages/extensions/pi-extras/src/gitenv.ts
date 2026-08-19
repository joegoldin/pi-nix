// Keep git from opening an editor.
//
// A `git commit` with no -m, a `git rebase -i`, or a merge that stops for a
// message all launch $GIT_EDITOR on a terminal the agent does not control. The
// command never returns, the tool call never ends, and the session is stuck
// until the user finds and kills it.
//
// GIT_EDITOR and GIT_SEQUENCE_EDITOR are enough: git prefers both over
// core.editor, $VISUAL and $EDITOR. EDITOR is deliberately left alone, because
// pi's own ctrl+g external editor falls back to it and a non-interactive value
// there would break a feature to protect one that is already protected.

/** `true` exits 0 without writing, which git reads as "the message stands". */
export const DEFAULT_GIT_EDITOR = "true";

const VARIABLES = ["GIT_EDITOR", "GIT_SEQUENCE_EDITOR"];

/** The variables to set, skipping any the user chose deliberately. */
export function gitEditorOverrides(env: Record<string, string | undefined>): Record<string, string> {
	const editor = env.PI_EXTRAS_GIT_EDITOR || DEFAULT_GIT_EDITOR;
	const overrides: Record<string, string> = {};
	for (const name of VARIABLES) {
		if (!env[name]) overrides[name] = editor;
	}
	return overrides;
}
