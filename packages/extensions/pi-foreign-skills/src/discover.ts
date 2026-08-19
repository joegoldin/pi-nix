// pi loads skills from ~/.pi/agent/skills, ~/.agents/skills, .pi/skills, and
// .agents/skills walking up from the cwd. It does not read .claude/skills, and
// settings.json cannot add one: `skills` there is an enable/disable filter
// whose entries must start with `!`, `+` or `-` (package-manager.js's
// getOverridePatterns discards anything else), so a plain path in that array is
// silently dropped. `packages` is the only settings key that adds a source, and
// it is global, which is the wrong shape for a directory that depends on where
// pi was launched.
//
// `resources_discover` is the supported answer: pi fires it after session_start
// with the cwd and takes skillPaths back.

import * as fs from "node:fs";
import * as path from "node:path";

/** Directory names searched under each root, in order. */
export const FOREIGN_SKILL_DIRS = [".claude/skills"] as const;

export interface DiscoverDeps {
	existsSync?: (p: string) => boolean;
	statSync?: (p: string) => { isDirectory(): boolean };
}

/**
 * Skill directories to hand pi for a session launched in `cwd`.
 *
 * Only the launch directory is searched. pi walks ancestors for `.agents/skills`
 * itself, but doing the same for `.claude/skills` would pull a parent
 * repository's skills into a nested checkout, and the ancestor of a worktree is
 * frequently unrelated to it.
 *
 * A path is returned only when it is a real directory: pi logs a diagnostic for
 * a resource path it cannot read, and a missing .claude is the common case
 * rather than an error worth reporting once per session.
 */
export function discoverForeignSkillDirs(cwd: string, deps: DiscoverDeps = {}): string[] {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const statSync = deps.statSync ?? fs.statSync;

	const found: string[] = [];
	for (const rel of FOREIGN_SKILL_DIRS) {
		const candidate = path.resolve(cwd, rel);
		if (!existsSync(candidate)) continue;
		try {
			if (statSync(candidate).isDirectory()) found.push(candidate);
		} catch {
			// A racing unlink between exists and stat is not worth a diagnostic.
		}
	}
	return found;
}
