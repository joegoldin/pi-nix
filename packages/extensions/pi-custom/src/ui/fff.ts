// The live half of search.ts: the FFF index for the session, the find and
// grep tools that consult it, and @ file completion ranked by it.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	DEFAULT_MAX_BYTES,
	type ExtensionAPI,
	formatSize,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { FileFinder, type FileFinderApi, type GrepCursor } from "@ff-labs/fff-bun";
import {
	deniedPathMatcher,
	deniedPathsFromEnv,
	fffDbDir,
	fffGlob,
	fffQuery,
	formatGrep,
	type GrepMatchLike,
	insideRoot,
	withinSearch,
} from "./search.ts";

// pi's grep quotes this in its line-truncation notice; it does not export it.
const GREP_MAX_LINE_LENGTH = 500;
const DEFAULT_GREP_LIMIT = 100;
// A page large enough that most searches finish in one, small enough that a
// common word in a big repo does not stall the turn.
const GREP_PAGE = 500;
const GREP_MAX_PAGES = 20;

/** The session's index. Absent until session_start, and whenever FFF declines the directory. */
export class SearchIndex {
	finder: FileFinderApi | undefined;
	root = "";

	open(cwd: string, agentDir: string): void {
		this.close();
		const dbDir = fffDbDir(agentDir);
		mkdirSync(dbDir, { recursive: true });
		const created = FileFinder.create({
			basePath: cwd,
			frecencyDbPath: join(dbDir, "frecency.db"),
			historyDbPath: join(dbDir, "history.db"),
			aiMode: true,
		});
		// FFF refuses $HOME and / by default. That is the right call: indexing a
		// whole home directory to answer one find is worse than fd.
		if (!created.ok) return;
		this.finder = created.value;
		this.root = cwd;
	}

	close(): void {
		if (this.finder && !this.finder.isDestroyed) this.finder.destroy();
		this.finder = undefined;
		this.root = "";
	}
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

export function registerSearchTools(pi: ExtensionAPI, index: SearchIndex, enabled: () => boolean): void {
	const denied = deniedPathMatcher(deniedPathsFromEnv(), homedir());
	const baseFind = createFindToolDefinition(process.cwd());
	pi.registerTool({
		...baseFind,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const finder = index.finder;
			const searchRel = finder ? insideRoot(index.root, resolve(cwd, params.path || ".")) : undefined;
			if (enabled() && finder && searchRel !== undefined) {
				const viaFff = createFindToolDefinition(cwd, {
					operations: {
						exists: (p: string) => existsSync(p),
						glob: (pattern: string, _searchPath: string, options: { limit: number }) => {
							const found = finder.glob(fffGlob(pattern, searchRel), { pageSize: options.limit });
							if (!found.ok) throw new Error(found.error);
							return found.value.items
								.map((item) => join(index.root, item.relativePath))
								.filter((path) => !denied(path));
						},
					},
				});
				try {
					const result = await viaFff.execute(toolCallId, params, signal, onUpdate, ctx);
					if (!textOf(result).startsWith("No files found")) return result;
				} catch {
					// Fall through to fd, which reports real errors in pi's own words.
				}
			}
			return createFindToolDefinition(cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	const baseGrep = createGrepToolDefinition(process.cwd());
	pi.registerTool({
		...baseGrep,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const runPi = () => createGrepToolDefinition(cwd).execute(toolCallId, params, signal, onUpdate, ctx);
			const finder = index.finder;
			if (!enabled() || !finder || params.glob) return runPi();
			const searchPath = resolve(cwd, params.path || ".");
			const searchRel = insideRoot(index.root, searchPath);
			if (searchRel === undefined || !existsSync(searchPath)) return runPi();
			const searchIsFile = statSync(searchPath).isFile();

			const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
			const context = params.context && params.context > 0 ? params.context : 0;
			const { query, mode } = fffQuery(params.pattern, params.literal === true, params.ignoreCase === true);

			const matches: GrepMatchLike[] = [];
			let cursor: GrepCursor | null = null;
			for (let page = 0; page < GREP_MAX_PAGES && matches.length < limit; page++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const found = finder.grep(query, {
					mode,
					smartCase: false,
					beforeContext: context,
					afterContext: context,
					pageSize: GREP_PAGE,
					cursor,
				});
				// A pattern FFF's engine read differently from ripgrep's is ripgrep's to answer.
				if (!found.ok || found.value.regexFallbackError) return runPi();
				for (const m of found.value.items) {
					if (withinSearch(m, searchRel, searchIsFile) && !denied(join(index.root, m.relativePath))) matches.push(m);
				}
				cursor = found.value.nextCursor;
				if (!cursor) break;
			}
			// No hits may only mean the file is one FFF does not index (hidden or
			// ignored) and ripgrep, run with --hidden, does.
			if (matches.length === 0) return runPi();

			const matchLimitReached = matches.length >= limit;
			const { lines, linesTruncated } = formatGrep(matches.slice(0, limit), searchRel, searchIsFile, (line) =>
				truncateLine(line),
			);
			const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: Record<string, unknown> = {};
			const notices: string[] = [];
			if (matchLimitReached) {
				notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
				details.matchLimitReached = limit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return {
				content: [{ type: "text" as const, text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	});
}

/** @ completions from the index, in the item shape pi's own completer applies. */
export function fileSuggestions(index: SearchIndex, query: string, limit = 20): Array<{ value: string; label: string; description?: string }> {
	const finder = index.finder;
	if (!finder) return [];
	const found = finder.fileSearch(query, { pageSize: limit });
	if (!found.ok) return [];
	return found.value.items.map((item) => {
		const path = item.relativePath;
		const value = /\s/.test(path) ? `@"${path}"` : `@${path}`;
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined;
		return { value, label: item.fileName, description: dir };
	});
}

/** Teach the index which file a query led to, which is what makes the next ranking better. */
export function trackSelection(index: SearchIndex, query: string, value: string): void {
	const path = value.replace(/^@"?|"$/g, "");
	index.finder?.trackQuery(query, join(index.root, path));
}
