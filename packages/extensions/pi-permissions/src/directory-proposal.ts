import { dirname } from "node:path";
import { extractInputPath, isInside, resolvePathForPolicy, resolveToolInputPath } from "./auto/paths.ts";
import { writableDirectory, type DirectoryAccess } from "./directory-access.ts";

export const DIRECTORY_ACCESS = ["read", "write", "execute", "read-execute", "write-execute"] as const;

export interface DirectoryCandidate extends DirectoryAccess {
	folders?: string[];
	readRequired?: boolean;
}

export function directoryCandidates(directories: DirectoryAccess[], toolName: string, input: Record<string, unknown>, cwd: string): DirectoryCandidate[] {
	const raw = ["read", "write", "edit"].includes(toolName) ? extractInputPath(toolName, input) : undefined;
	const target = raw === undefined ? undefined : resolveToolInputPath(toolName, cwd, raw);
	const canonical = target && resolvePathForPolicy(target);
	const parent = canonical && dirname(canonical);
	return directories.map(directory => ({ ...directory, readRequired: toolName !== "bash" && toolName !== "bg_run", folders: parent && !/[\u0000-\u001f\u007f]/.test(parent) && parent !== directory.path && isInside(parent, directory.path)
		? [directory.path, parent] : [directory.path] }));
}

/** Model output can select capabilities, never invent or widen a native target. */
export function validateDirectoryProposal(value: unknown, candidates: readonly DirectoryCandidate[]): DirectoryAccess[] | undefined {
	if (!value || typeof value !== "object") return;
	const rows = (value as { directories?: unknown }).directories;
	if (!Array.isArray(rows) || rows.length !== candidates.length || !rows.length) return;
	const seen = new Set<number>();
	const result: DirectoryAccess[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object" || Object.keys(row).some(key => key !== "candidate" && key !== "access" && key !== "folder")) return;
		if (!Number.isInteger(row.candidate) || seen.has(row.candidate) || !DIRECTORY_ACCESS.includes(row.access)) return;
		const candidate = candidates[row.candidate];
		if (!candidate || (writableDirectory(candidate.access) && !writableDirectory(row.access))) return;
		if (candidate.access === "read" && candidate.readRequired !== false && row.access === "execute") return;
		const folder = row.folder ?? 0;
		if (!Number.isInteger(folder) || folder < 0) return;
		const path = candidate.folders ? candidate.folders[folder] : folder === 0 ? candidate.path : undefined;
		if (!path) return;
		seen.add(row.candidate);
		result.push({ path, access: row.access });
	}
	return result;
}
