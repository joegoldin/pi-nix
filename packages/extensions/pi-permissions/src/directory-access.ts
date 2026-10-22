import { existsSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { resolvePathForPolicy } from "./auto/paths.ts";

export interface DirectoryAccess {
	path: string;
	access: "read" | "write";
}

export interface DirectoryApproval extends DirectoryAccess {
	kind: "directory";
	scope: string;
	at: number;
}

/** Prefer a worktree/repository boundary to asking again for every source subdirectory. */
function projectBoundary(directory: string): string {
	let current = directory;
	while (true) {
		if (existsSync(resolve(current, ".git")) || existsSync(resolve(current, ".jj"))) return current;
		const parent = dirname(current);
		if (parent === current) return directory;
		current = parent;
	}
}

/** These are native gate suggestions, not paths guessed from shell text or model output. */
export function requestedDirectories(details: Record<string, unknown> | undefined, cwd: string): DirectoryAccess[] {
	const suggestion = details?.sessionApproval as { grants?: { surface: string; pattern: string }[] } | undefined;
	if (!Array.isArray(suggestion?.grants)) return [];
	const directories = new Map<string, DirectoryAccess>();
	for (const grant of suggestion.grants) {
		if (grant.surface !== "external_directory_read" && grant.surface !== "external_directory_write") continue;
		// File gates supply only the parent contents pattern; directory gates
		// additionally supply the exact directory. Both have the same access scope.
		if (typeof grant.pattern !== "string" || !grant.pattern.endsWith("/*")) continue;
		const directory = grant.pattern.slice(0, -1);
		if (!isAbsolute(directory) || /[*?\[\]]/.test(directory)) continue;
		const resolved = resolve(cwd, directory);
		const canonical = resolvePathForPolicy(resolved);
		if (!canonical || !isAbsolute(canonical)) continue;
		const path = projectBoundary(canonical);
		if (path === parse(path).root) continue;
		const access = grant.surface === "external_directory_write" ? "write" : "read";
		const previous = directories.get(path);
		if (!previous || access === "write") directories.set(path, { path, access });
	}
	return [...directories.values()];
}

export function directoryScopeLabel(directories: readonly DirectoryAccess[]): string {
	return directories.map(({ path, access }) => `${access === "write" ? "Read/write" : "Read-only"} access under ${path}`).join("; ") +
		" for this conversation, until revoked. Access only: destructive cleanup, discarded work, secrets, publishing, deployment and other action-specific risks still require review; later instructions can narrow this access.";
}
