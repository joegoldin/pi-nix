import { existsSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { extractInputPath, isInside, resolvePathForPolicy, resolveToolInputPath } from "./auto/paths.ts";

export interface DirectoryAccess {
	path: string;
	access: "read" | "write" | "execute" | "read-execute" | "write-execute";
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
export function requestedDirectories(details: Record<string, unknown> | undefined, cwd: string, call?: { toolName: string; input: Record<string, unknown> }): DirectoryAccess[] {
	const suggestion = details?.sessionApproval as { grants?: { surface: string; pattern: string }[] } | undefined;
	const directories = new Map<string, DirectoryAccess>();
	for (const grant of Array.isArray(suggestion?.grants) ? suggestion.grants : []) {
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
	if (call && ["read", "write", "edit"].includes(call.toolName)) {
		const raw = extractInputPath(call.toolName, call.input);
		const target = raw === undefined ? undefined : resolveToolInputPath(call.toolName, cwd, raw);
		const canonical = target && resolvePathForPolicy(target);
		if (canonical) {
			const path = projectBoundary(dirname(canonical));
			const access = call.toolName === "read" ? "read" : "write";
			if (!directories.has(path) || access === "write") directories.set(path, { path, access });
		}
	}
	return [...directories.values()].filter(({ path }) => path !== parse(path).root && path !== homedir() && !/[\u0000-\u001f\u007f]/.test(path));
}

export function writableDirectory(access: DirectoryAccess["access"]): boolean {
	return access === "write" || access === "write-execute";
}

/** The gate's canonical boundary is the target; matchValues are policy aliases. */
export function coversDirectoryRequest(details: Record<string, unknown>, grants: readonly DirectoryAccess[]): boolean {
	const intent = details.accessIntent as { surface?: unknown; boundaryValue?: unknown } | undefined;
	if (!intent || (intent.surface !== "external_directory_read" && intent.surface !== "external_directory_write") ||
		typeof intent.boundaryValue !== "string" || !isAbsolute(intent.boundaryValue)) return false;
	const path = resolvePathForPolicy(intent.boundaryValue);
	return !!path && grants.some(grant => isInside(path, grant.path) && grant.access !== "execute" &&
		(intent.surface === "external_directory_read" || writableDirectory(grant.access)));
}

export function directoryScopeLabel(directories: readonly DirectoryAccess[]): string {
	const labels = { read: "Read-only", write: "Read/write", execute: "Execute", "read-execute": "Read/execute", "write-execute": "Read/write/execute" };
	return directories.map(({ path, access }) => `${labels[access]} access under ${path}`).join("; ") +
		" for this conversation, until revoked. Access only: destructive cleanup, discarded work, secrets, publishing, deployment and other action-specific risks still require review; later instructions can narrow this access.";
}
