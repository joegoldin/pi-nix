// pi-custom's settings: what /ui edits, and what every other module reads.
//
// One flat JSON file under the agent directory, written whole on every change.
// Flat because the panel is a flat list and a nested file would need a second
// mapping between the two; whole because a partial write that dies halfway
// leaves a file the next session cannot parse.
//
// Unknown keys and wrong types are dropped back to the default rather than
// rejected: the file is edited by hand as often as by the panel, and a typo in
// one key should cost that key, not the whole UI.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ToolMode = "on" | "compact" | "off";
export type DiffLayout = "auto" | "unified" | "split";

export interface UiConfig {
	/** Claude Code-style tool cards: full cards, one-line cards, or pi's own rendering. */
	toolMode: ToolMode;
	/** Side by side needs width; auto switches at diffSplitMinWidth. */
	diffLayout: DiffLayout;
	diffSplitMinWidth: number;
	/** Body rows shown before a card collapses behind the expand hint. */
	collapsedLines: number;
	/** Hard cap on body rows even when expanded, so one huge result cannot bury the transcript. */
	expandedLines: number;
	/** Fold a finished run of reads, searches and shell commands into one line, as Claude Code does. */
	groupRuns: boolean;
	/** Nerd Font glyphs for files and directories; off for terminals without the font. */
	nerdIcons: boolean;
	/** `> [!NOTE]` and friends drawn as callouts instead of plain quotes. */
	admonitions: boolean;
	/** Bare URLs in messages turned into links the terminal can open. */
	linkUrls: boolean;
	/** The ❯ before your own messages and in the prompt box. */
	promptIcon: boolean;
	/** The sweep across the working message while the agent runs. */
	shimmer: boolean;
	/** @session: references to earlier sessions. */
	sessionReferences: boolean;
	/** @agent: references to subagents. */
	agentReferences: boolean;
	/** find, grep and @ file completion through FFF's frecency index. */
	fffSearch: boolean;
	/** Automatic /goal turns before the goal pauses for review; 0 for no limit. */
	goalTurnLimit: number;
	/** Identical tool-free goal replies in a row before the goal pauses; 0 to never. */
	goalNoProgressTurns: number;
	/** The "✻ Worked for 57s · done 11:11 AM" line after a run, so a long one's end is visible. */
	turnSummary: boolean;
	/** Runs shorter than this get no summary line; 0 for every run. */
	turnSummaryMinSeconds: number;
}

export const DEFAULTS: UiConfig = {
	toolMode: "on",
	diffLayout: "auto",
	diffSplitMinWidth: 120,
	collapsedLines: 6,
	expandedLines: 200,
	groupRuns: true,
	nerdIcons: true,
	admonitions: true,
	linkUrls: true,
	promptIcon: true,
	shimmer: true,
	sessionReferences: true,
	agentReferences: true,
	fffSearch: true,
	goalTurnLimit: 25,
	goalNoProgressTurns: 3,
	turnSummary: true,
	turnSummaryMinSeconds: 5,
};

const TOOL_MODES: readonly ToolMode[] = ["on", "compact", "off"];
const DIFF_LAYOUTS: readonly DiffLayout[] = ["auto", "unified", "split"];

/** Where the file lives: next to pi's own settings, honouring PI_CODING_AGENT_DIR like pi does. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "pi-custom.json");
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function pickInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Coerce anything JSON.parse produced into a complete config. */
export function normalise(raw: unknown): UiConfig {
	const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		toolMode: pickEnum(v.toolMode, TOOL_MODES, DEFAULTS.toolMode),
		diffLayout: pickEnum(v.diffLayout, DIFF_LAYOUTS, DEFAULTS.diffLayout),
		diffSplitMinWidth: pickInt(v.diffSplitMinWidth, DEFAULTS.diffSplitMinWidth, 60, 400),
		collapsedLines: pickInt(v.collapsedLines, DEFAULTS.collapsedLines, 0, 100),
		expandedLines: pickInt(v.expandedLines, DEFAULTS.expandedLines, 10, 5000),
		groupRuns: pickBool(v.groupRuns, DEFAULTS.groupRuns),
		nerdIcons: pickBool(v.nerdIcons, DEFAULTS.nerdIcons),
		admonitions: pickBool(v.admonitions, DEFAULTS.admonitions),
		linkUrls: pickBool(v.linkUrls, DEFAULTS.linkUrls),
		promptIcon: pickBool(v.promptIcon, DEFAULTS.promptIcon),
		shimmer: pickBool(v.shimmer, DEFAULTS.shimmer),
		sessionReferences: pickBool(v.sessionReferences, DEFAULTS.sessionReferences),
		agentReferences: pickBool(v.agentReferences, DEFAULTS.agentReferences),
		fffSearch: pickBool(v.fffSearch, DEFAULTS.fffSearch),
		goalTurnLimit: pickInt(v.goalTurnLimit, DEFAULTS.goalTurnLimit, 0, 10_000),
		goalNoProgressTurns: pickInt(v.goalNoProgressTurns, DEFAULTS.goalNoProgressTurns, 0, 100),
		turnSummary: pickBool(v.turnSummary, DEFAULTS.turnSummary),
		turnSummaryMinSeconds: pickInt(v.turnSummaryMinSeconds, DEFAULTS.turnSummaryMinSeconds, 0, 3600),
	};
}

export function loadConfig(path = configPath()): UiConfig {
	if (!existsSync(path)) return { ...DEFAULTS };
	try {
		return normalise(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// An unparseable file is a hand edit in progress; defaults until it parses.
		return { ...DEFAULTS };
	}
}

/** Write through a sibling temp file so a crash mid-write never leaves half a file. */
export function saveConfig(config: UiConfig, path = configPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
	renameSync(tmp, path);
}
