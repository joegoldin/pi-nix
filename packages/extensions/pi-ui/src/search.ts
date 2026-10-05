// find, grep and @ file completion backed by FFF's frecency index.
//
// FFF keeps one native index of the session's directory, ranked by how
// recently and how often files are opened and changed, so the files you are
// working on come first. It answers the common cases; anything it cannot
// answer the way pi's own tools would falls back to them, so the model never
// gets a different answer for using pi-ui:
//
//   find  goes through pi's own find tool with an FFF glob behind its
//         `operations.glob` hook, so output, limits and notices stay pi's.
//         An empty FFF answer to a glob retries with fd: the index may still
//         be warming, or the files may be ignored by FFF and not by fd.
//   grep  is answered by FFF when the search stays inside the index and has
//         no `glob` filter, formatted exactly as pi's ripgrep-backed grep.
//         Everything else runs pi's grep.

import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface GrepMatchLike {
	relativePath: string;
	lineNumber: number;
	lineContent: string;
	contextBefore?: string[];
	contextAfter?: string[];
	isBinary?: boolean;
}

/** A path inside the index root, as the index names it; undefined when outside. */
export function insideRoot(root: string, path: string): string | undefined {
	const rel = relative(root, resolve(root, path));
	if (rel === "") return "";
	if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split(sep).join("/");
}

/**
 * fd matches a bare `*.ts` against file names anywhere below the search
 * directory; FFF's glob matches whole index-relative paths. Rewrite the
 * pattern into the path form fd's behaviour implies, rooted at the search
 * directory's place in the index.
 */
export function fffGlob(pattern: string, searchRel: string): string {
	let p = pattern.trim().replace(/^\/+/, "");
	if (!p.includes("/") && !p.startsWith("**")) p = `**/${p}`;
	return searchRel ? `${searchRel}/${p}` : p;
}

/** The grep query FFF should run: plain text when it can, a regex otherwise. */
export function fffQuery(pattern: string, literal: boolean, ignoreCase: boolean): { query: string; mode: "plain" | "regex" } {
	if (literal && !ignoreCase) return { query: pattern, mode: "plain" };
	const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
	return { query: ignoreCase ? `(?i)${source}` : source, mode: "regex" };
}

/**
 * Format FFF matches the way pi's grep does: `path:line: text` for a match,
 * `path-line- text` for context, paths relative to the searched directory,
 * or the bare file name when a single file was searched.
 */
export function formatGrep(
	matches: GrepMatchLike[],
	searchRel: string,
	searchIsFile: boolean,
	truncateLine: (line: string) => { text: string; wasTruncated: boolean },
): { lines: string[]; linesTruncated: boolean } {
	const lines: string[] = [];
	let linesTruncated = false;
	const show = (line: string) => {
		const t = truncateLine(line.replace(/\r/g, ""));
		if (t.wasTruncated) linesTruncated = true;
		return t.text;
	};
	for (const m of matches) {
		const name = searchIsFile
			? (m.relativePath.split("/").pop() ?? m.relativePath)
			: searchRel
				? m.relativePath.slice(searchRel.length + 1)
				: m.relativePath;
		const before = m.contextBefore ?? [];
		before.forEach((text, i) => lines.push(`${name}-${m.lineNumber - before.length + i}- ${show(text)}`));
		lines.push(`${name}:${m.lineNumber}: ${show(m.lineContent)}`);
		(m.contextAfter ?? []).forEach((text, i) => lines.push(`${name}-${m.lineNumber + 1 + i}- ${show(text)}`));
	}
	return { lines, linesTruncated };
}

/** Matches under the searched directory or equal to the searched file. */
export function withinSearch(match: GrepMatchLike, searchRel: string, searchIsFile: boolean): boolean {
	if (match.isBinary) return false;
	if (searchIsFile) return match.relativePath === searchRel;
	return searchRel === "" || match.relativePath.startsWith(`${searchRel}/`);
}

/** Where the frecency and query-history databases live, next to pi's own state. */
export function fffDbDir(agentDir: string): string {
	return join(agentDir, "pi-ui", "fff");
}
