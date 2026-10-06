// What each tool's card says. Pure: a call and its result in, a CardModel out.
//
// Built-in tools get a card written for them: the verb Claude Code uses, the
// argument that identifies the call, and a body that shows the useful part of
// the result. Anything else gets the generic card, which still reads better
// than a raw argument dump. Tools that ship their own renderers keep them; that
// decision lives in render.ts, not here.

import { relative, isAbsolute } from "node:path";
import type { CardModel, CardState, UiTheme } from "./card.ts";
import type { UiConfig } from "./config.ts";
import { countChanges, parseDiff, renderDiffRows } from "./diff.ts";
import { iconFor } from "./icons.ts";

export interface ToolResultLike {
	content?: Array<{ type: string; text?: string; mimeType?: string }>;
	details?: unknown;
}

export interface CardInput {
	toolName: string;
	args: Record<string, unknown>;
	result?: ToolResultLike;
	isPartial: boolean;
	isError: boolean;
	cwd: string;
	/** For write: the file's content before the call, null when it did not exist,
	 *  undefined when unknown (a session resumed from disk). */
	prior?: string | null;
}

export interface CardDeps {
	theme: UiTheme;
	config: UiConfig;
	/** pi's highlightCode, one themed string per input line. */
	highlight(code: string, lang: string | undefined): string[];
	/** pi's getLanguageFromPath. */
	languageOf(path: string): string | undefined;
	/** pi's generateDiffString, as the display diff its edit tool returns. */
	diff?(oldContent: string, newContent: string): string;
}

export const BUILT_IN_TOOLS = new Set(["read", "bash", "edit", "write", "ls", "find", "grep"]);

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** All text parts of a result, joined. */
export function textOf(result: ToolResultLike | undefined): string {
	return (result?.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

/**
 * pi appends notices to tool output as a final "[...]" paragraph: truncation,
 * limits, how to continue. Split it off so the body is only the payload and
 * the notice can be shown as one muted line.
 */
export function splitNotice(text: string): { body: string; notice?: string } {
	const m = /\n\n(\[[^\n]*\])\s*$/.exec(text);
	if (!m) return { body: text };
	return { body: text.slice(0, m.index), notice: m[1] };
}

/** Paths relative to the session's directory when they are inside it, as the model usually wrote them. */
export function displayPath(path: string, cwd: string): string {
	if (!isAbsolute(path)) return path;
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function oneLine(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

function linesOf(text: string): string[] {
	if (text === "") return [];
	return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

function stateOf(input: CardInput): CardState {
	if (!input.result || input.isPartial) return "pending";
	return input.isError ? "error" : "success";
}

/** An error card: the first line as the summary, the rest under it. */
function errorBody(input: CardInput, deps: CardDeps): Pick<CardModel, "summary" | "body"> {
	const lines = linesOf(textOf(input.result).trim());
	const [first = "Failed", ...rest] = lines;
	return {
		summary: deps.theme.fg("error", first),
		body: rest.map((line) => deps.theme.fg("error", line)),
	};
}

/** Code with a dimmed line-number gutter, highlighted for the file's language. */
function numberedCode(text: string, path: string, firstLine: number, deps: CardDeps): string[] {
	const highlighted = deps.highlight(text, deps.languageOf(path));
	const last = firstLine + highlighted.length - 1;
	const w = String(last).length;
	return highlighted.map((line, i) => `${deps.theme.fg("dim", String(firstLine + i).padStart(w))}  ${line}`);
}

const PI_DOCS = /\/@earendil-works\/pi-coding-agent\/(docs|examples)\/(.+)$/;

function readCard(input: CardInput, deps: CardDeps): CardModel {
	const { theme } = deps;
	const path = str(input.args.path) ?? "";
	const offset = num(input.args.offset);
	const limit = num(input.args.limit);
	// pi reads its own documentation from inside its store path; naming that
	// path in full says nothing, so it reads as what it is.
	const docs = PI_DOCS.exec(path);
	const model: CardModel = {
		title: docs ? "Read docs" : "Read",
		target: docs ? `pi ${docs[1]}/${docs[2]}` : displayPath(path, input.cwd),
		detail:
			offset !== undefined || limit !== undefined
				? [offset !== undefined ? `from ${offset}` : "", limit !== undefined ? `${limit} lines` : ""]
						.filter(Boolean)
						.join(", ")
				: undefined,
		state: stateOf(input),
	};
	if (model.state === "pending") return model;
	if (model.state === "error") return { ...model, ...errorBody(input, deps) };

	const image = input.result?.content?.find((part) => part.type === "image");
	if (image) return { ...model, summary: theme.fg("muted", `Read image (${image.mimeType ?? "image"})`) };

	const { body, notice } = splitNotice(textOf(input.result));
	const lines = linesOf(body);
	const summary = `Read ${theme.bold(String(lines.length))} ${lines.length === 1 ? "line" : "lines"}`;
	return {
		...model,
		summary: notice ? `${summary} ${theme.fg("muted", notice)}` : summary,
		body: numberedCode(lines.join("\n"), path, offset ?? 1, deps),
	};
}

const EXIT = /\n*Command exited with code (\d+)\s*$/;

export function splitExit(text: string): { output: string; code?: number } {
	const m = EXIT.exec(text);
	return m ? { output: text.slice(0, m.index), code: Number(m[1]) } : { output: text };
}

function bashCard(input: CardInput, deps: CardDeps): CardModel {
	const { theme } = deps;
	const command = str(input.args.command) ?? "";
	const timeout = num(input.args.timeout);
	const model: CardModel = {
		title: "Bash",
		target: oneLine(command),
		detail: timeout !== undefined ? `timeout ${timeout}s` : undefined,
		state: stateOf(input),
		tail: true,
	};
	if (!input.result) return model;

	const { body, notice } = splitNotice(textOf(input.result));
	const { output, code } = splitExit(body);
	const lines = linesOf(output.trimEnd()).map((line) => theme.fg("toolOutput", line));
	// A command that wrote nothing still needs a line, or the card looks unfinished.
	const status =
		code !== undefined && code !== 0
			? theme.fg("error", `exit ${code}`)
			: input.isPartial
				? undefined
				: lines.length === 0
					? theme.fg("muted", "(no output)")
					: undefined;
	const tailNotes = [notice ? theme.fg("muted", notice) : undefined].filter((x): x is string => !!x);
	return {
		...model,
		state: code !== undefined && code !== 0 ? "error" : model.state,
		summary: status,
		body: [...lines, ...tailNotes],
	};
}

function editCard(input: CardInput, deps: CardDeps): CardModel {
	const { theme, config } = deps;
	const path = str(input.args.path) ?? "";
	const model: CardModel = { title: "Update", target: displayPath(path, input.cwd), state: stateOf(input) };
	if (model.state === "pending") return model;
	if (model.state === "error") return { ...model, ...errorBody(input, deps) };

	const diff = (input.result?.details as { diff?: unknown } | undefined)?.diff;
	if (typeof diff !== "string" || diff === "") return { ...model, summary: theme.fg("muted", "Applied") };
	const rows = parseDiff(diff);
	const { added, removed } = countChanges(rows);
	const summary = `Updated ${theme.bold(model.target ?? path)} with ${theme.fg("toolDiffAdded", plural(added, "addition"))} and ${theme.fg(
		"toolDiffRemoved",
		plural(removed, "removal"),
	)}`;
	return {
		...model,
		summary,
		body: (width) => renderDiffRows(rows, config.diffLayout, config.diffSplitMinWidth, width, theme),
	};
}

function writeCard(input: CardInput, deps: CardDeps): CardModel {
	const { theme, config } = deps;
	const path = str(input.args.path) ?? "";
	const content = str(input.args.content) ?? "";
	const model: CardModel = { title: "Write", target: displayPath(path, input.cwd), state: stateOf(input) };
	if (model.state === "pending") return model;
	if (model.state === "error") return { ...model, ...errorBody(input, deps) };
	// Overwriting a file is an edit with every line in play; show it as one.
	if (typeof input.prior === "string" && deps.diff) {
		if (input.prior === content) return { ...model, summary: theme.fg("muted", "Unchanged") };
		const rows = parseDiff(deps.diff(input.prior, content));
		const { added, removed } = countChanges(rows);
		return {
			...model,
			summary: `Overwrote ${theme.bold(model.target ?? path)} with ${theme.fg("toolDiffAdded", plural(added, "addition"))} and ${theme.fg(
				"toolDiffRemoved",
				plural(removed, "removal"),
			)}`,
			body: (width) => renderDiffRows(rows, config.diffLayout, config.diffSplitMinWidth, width, theme),
		};
	}
	// A new file (or one whose old content is unknown) is shown as Claude Code
	// shows it: the opening lines, numbered and highlighted, not a diff
	// against nothing.
	const lines = linesOf(content);
	return {
		...model,
		summary: `Wrote ${theme.bold(String(lines.length))} ${lines.length === 1 ? "line" : "lines"} to ${theme.bold(model.target ?? path)}`,
		body: numberedCode(lines.join("\n"), path, 1, deps),
	};
}

function lsCard(input: CardInput, deps: CardDeps): CardModel {
	const { theme, config } = deps;
	const path = str(input.args.path) ?? ".";
	const model: CardModel = { title: "List", target: displayPath(path, input.cwd), state: stateOf(input) };
	if (model.state === "pending") return model;
	if (model.state === "error") return { ...model, ...errorBody(input, deps) };
	const { body, notice } = splitNotice(textOf(input.result));
	const entries = body.trim() === "(empty directory)" ? [] : linesOf(body);
	const rows = entries.map((entry) => {
		const isDir = entry.endsWith("/");
		const icon = iconFor(entry, isDir, config.nerdIcons);
		return isDir ? theme.fg("accent", `${icon}${entry}`) : `${theme.fg("muted", icon)}${entry}`;
	});
	const summary = `Listed ${theme.bold(String(entries.length))} ${entries.length === 1 ? "entry" : "entries"}`;
	return { ...model, summary: notice ? `${summary} ${theme.fg("muted", notice)}` : summary, body: rows };
}

function findCard(input: CardInput, deps: CardDeps): CardModel {
	const { theme, config } = deps;
	const pattern = str(input.args.pattern) ?? "";
	const path = str(input.args.path);
	const model: CardModel = {
		title: "Search",
		target: `files: ${JSON.stringify(pattern)}`,
		detail: path ? `in ${displayPath(path, input.cwd)}` : undefined,
		state: stateOf(input),
	};
	if (model.state === "pending") return model;
	if (model.state === "error") return { ...model, ...errorBody(input, deps) };
	const { body, notice } = splitNotice(textOf(input.result));
	const files = body.trim() === "No files found matching pattern" ? [] : linesOf(body);
	const summary = `Found ${theme.bold(String(files.length))} ${files.length === 1 ? "file" : "files"}`;
	return {
		...model,
		summary: notice ? `${summary} ${theme.fg("muted", notice)}` : summary,
		body: files.map((file) => `${theme.fg("muted", iconFor(file, false, config.nerdIcons))}${file}`),
	};
}

/** A regex for the grep pattern, for colouring matches; undefined when the pattern does not compile here. */
export function matcherFor(pattern: string, literal: boolean, ignoreCase: boolean): RegExp | undefined {
	if (!pattern) return undefined;
	const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
	try {
		return new RegExp(source, ignoreCase ? "gi" : "g");
	} catch {
		return undefined;
	}
}

function markMatches(text: string, matcher: RegExp | undefined, theme: UiTheme): string {
	if (!matcher) return text;
	return text.replace(matcher, (hit) => (hit ? theme.bold(theme.fg("warning", hit)) : hit));
}

const GREP_MATCH = /^(.*?):(\d+): (.*)$/;
const GREP_CONTEXT = /^(.*?)-(\d+)- (.*)$/;

function grepCard(input: CardInput, deps: CardDeps): CardModel {
	const { theme, config } = deps;
	const pattern = str(input.args.pattern) ?? "";
	const path = str(input.args.path);
	const glob = str(input.args.glob);
	const model: CardModel = {
		title: "Search",
		target: `pattern: ${JSON.stringify(pattern)}`,
		detail: [path ? `in ${displayPath(path, input.cwd)}` : "", glob ? `glob ${glob}` : ""].filter(Boolean).join(", ") || undefined,
		state: stateOf(input),
	};
	if (model.state === "pending") return model;
	if (model.state === "error") return { ...model, ...errorBody(input, deps) };

	const { body, notice } = splitNotice(textOf(input.result));
	if (body.trim() === "No matches found") return { ...model, summary: theme.fg("muted", "No matches") };

	const matcher = matcherFor(pattern, input.args.literal === true, input.args.ignoreCase === true);
	const rows: string[] = [];
	const files = new Set<string>();
	let matches = 0;
	let current: string | undefined;
	for (const line of linesOf(body)) {
		const hit = GREP_MATCH.exec(line);
		const ctx = hit ? undefined : GREP_CONTEXT.exec(line);
		const m = hit ?? ctx;
		if (!m) continue;
		const [, file, lineNo, text] = m;
		if (file !== current) {
			current = file;
			files.add(file);
			rows.push(theme.fg("accent", `${iconFor(file, false, config.nerdIcons)}${file}`));
		}
		if (hit) matches++;
		const gutter = theme.fg("dim", `${lineNo.padStart(5)}${hit ? ":" : " "}`);
		rows.push(`${gutter} ${hit ? markMatches(text, matcher, theme) : theme.fg("muted", text)}`);
	}
	const summary = `Found ${theme.bold(String(matches))} ${matches === 1 ? "match" : "matches"} in ${plural(files.size, "file")}`;
	return { ...model, summary: notice ? `${summary} ${theme.fg("muted", notice)}` : summary, body: rows };
}

/** `mcp__github__search_issues` reads better as `github · search_issues`. */
/** What a call is doing, in a few words, for a run's live line: the command, the path, the pattern. */
export function callActivity(toolName: string, args: Record<string, unknown>, cwd: string): string {
	const path = str(args.path);
	switch (toolName) {
		case "bash":
			return `$ ${oneLine(str(args.command) ?? "", Infinity)}`;
		case "read":
			return displayPath(path ?? "", cwd);
		case "ls":
			return displayPath(path ?? ".", cwd);
		case "grep":
		case "find":
			return `${JSON.stringify(str(args.pattern) ?? "")}${path ? ` in ${displayPath(path, cwd)}` : ""}`;
		default:
			return toolName;
	}
}

export function toolTitle(name: string): string {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
	return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/** Arguments as `key: value` pairs on one line, the way a reader scans them. */
export function summariseArgs(args: Record<string, unknown>): string {
	return Object.entries(args)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(oneLine(v, 60)) : oneLine(JSON.stringify(v) ?? "", 60)}`)
		.join(", ");
}

function genericCard(input: CardInput, deps: CardDeps): CardModel {
	const { theme } = deps;
	const model: CardModel = {
		title: toolTitle(input.toolName),
		target: summariseArgs(input.args) || undefined,
		state: stateOf(input),
	};
	if (model.state === "pending") return model;
	if (model.state === "error") return { ...model, ...errorBody(input, deps) };
	const lines = linesOf(textOf(input.result).trim());
	if (lines.length === 0) return { ...model, summary: theme.fg("muted", "Done") };
	const [first, ...rest] = lines;
	return { ...model, summary: theme.fg("toolOutput", first), body: rest.map((line) => theme.fg("toolOutput", line)) };
}

/** intercom (pi-custom's own): who it talked to, and what came back, without the markdown bold. */
function intercomCard(input: CardInput, deps: CardDeps): CardModel {
	const { theme } = deps;
	const action = str(input.args.action) ?? "intercom";
	const to = str(input.args.to)?.trim() || str(input.args.cwd)?.trim();
	const message = str(input.args.message);
	const model: CardModel = {
		title: "Intercom",
		target: to ? `${action} → ${to}` : action,
		detail: message ? oneLine(message, 60) : undefined,
		state: stateOf(input),
	};
	if (model.state === "pending") return model;
	if (model.state === "error") return { ...model, ...errorBody(input, deps) };
	const lines = linesOf(textOf(input.result).replace(/\*\*/g, "").trim());
	const roster = (input.result?.details as { roster?: { peers: number; total: number } } | undefined)?.roster;
	if (roster) {
		return {
			...model,
			summary: theme.fg("toolOutput", `${plural(roster.peers, "peer")} ${theme.fg("muted", `(${roster.total} connected)`)}`),
			body: lines.map((line) => theme.fg("toolOutput", line)),
		};
	}
	if (lines.length === 0) return { ...model, summary: theme.fg("muted", "Done") };
	const [first, ...rest] = lines;
	return { ...model, summary: theme.fg("toolOutput", first), body: rest.map((line) => theme.fg("toolOutput", line)) };
}

export function buildCard(input: CardInput, deps: CardDeps): CardModel {
	switch (input.toolName) {
		case "read":
			return readCard(input, deps);
		case "bash":
			return bashCard(input, deps);
		case "edit":
			return editCard(input, deps);
		case "write":
			return writeCard(input, deps);
		case "ls":
			return lsCard(input, deps);
		case "find":
			return findCard(input, deps);
		case "grep":
			return grepCard(input, deps);
		case "intercom":
			return intercomCard(input, deps);
		default:
			return genericCard(input, deps);
	}
}
