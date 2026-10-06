// /ui: every pi-custom setting in one list, saved as you change it.
//
// The list is pi-tui's own SettingsList, so it moves and filters like pi's
// /settings. Each row cycles through its values; numbers cycle through a few
// sensible stops rather than taking typed input, which a settings list has no
// good way to ask for.

import type { SettingItem } from "@earendil-works/pi-tui";
import type { UiConfig } from "./config.ts";

type Key = keyof UiConfig;

interface Row {
	key: Key;
	label: string;
	description: string;
	values: string[];
}

const ON_OFF = ["on", "off"];

const ROWS: Row[] = [
	{
		key: "toolMode",
		label: "Tool cards",
		description: "Claude Code-style cards, one-line cards, or pi's own rendering. Applies to new tool calls.",
		values: ["on", "compact", "off"],
	},
	{ key: "diffLayout", label: "Diff layout", description: "Side by side needs width; auto switches at the threshold below.", values: ["auto", "unified", "split"] },
	{ key: "diffSplitMinWidth", label: "Side-by-side from", description: "Terminal width at which auto shows diffs side by side.", values: ["100", "120", "140", "160"] },
	{ key: "collapsedLines", label: "Collapsed rows", description: "Result rows shown before a card folds behind the expand hint.", values: ["0", "3", "6", "10", "20"] },
	{ key: "expandedLines", label: "Expanded rows", description: "Most rows an expanded card shows.", values: ["50", "200", "1000"] },
	{ key: "nerdIcons", label: "File icons", description: "Nerd Font glyphs beside paths. Turn off without a Nerd Font.", values: ON_OFF },
	{ key: "admonitions", label: "Callouts", description: "Render > [!NOTE] and friends as labelled callouts.", values: ON_OFF },
	{ key: "linkUrls", label: "Link bare URLs", description: "Make bare URLs in messages clickable.", values: ON_OFF },
	{ key: "promptIcon", label: "Prompt icon", description: "The ❯ before your messages and in the prompt box.", values: ON_OFF },
	{ key: "shimmer", label: "Working shimmer", description: "The sweep across the working indicator.", values: ON_OFF },
	{ key: "sessionReferences", label: "@session: references", description: "Pull an earlier session's gist into a prompt.", values: ON_OFF },
	{ key: "agentReferences", label: "@agent: references", description: "Name a subagent in a prompt.", values: ON_OFF },
	{ key: "fffSearch", label: "FFF search", description: "find, grep and @ files through the frecency index.", values: ON_OFF },
	{
		key: "goalTurnLimit",
		label: "/goal turn limit",
		description: "Automatic /goal turns before the goal pauses for review. 0 means no limit.",
		values: ["10", "25", "50", "100", "0"],
	},
	{
		key: "goalNoProgressTurns",
		label: "/goal stall check",
		description: "Identical tool-free replies in a row before /goal pauses. 0 turns the check off.",
		values: ["2", "3", "5", "0"],
	},
	{ key: "turnSummary", label: "Run summary", description: "A line after each run: how long it took, when it finished, what is still running.", values: ON_OFF },
	{
		key: "turnSummaryMinSeconds",
		label: "Run summary from",
		description: "Seconds a run has to last before it gets a summary line. 0 means every run.",
		values: ["0", "5", "10", "30", "60"],
	},
];

function shown(value: UiConfig[Key]): string {
	return typeof value === "boolean" ? (value ? "on" : "off") : String(value);
}

export function settingItems(config: UiConfig): SettingItem[] {
	return ROWS.map((row) => {
		const current = shown(config[row.key]);
		// A hand-edited number between the stops still shows, as its own value.
		const values = row.values.includes(current) ? row.values : [...row.values, current];
		return { id: row.key, label: row.label, description: row.description, currentValue: current, values };
	});
}

/** Apply one row's new value, returning the updated config. Unknown ids change nothing. */
export function applySetting(config: UiConfig, id: string, value: string): UiConfig {
	const row = ROWS.find((r) => r.key === id);
	if (!row) return config;
	const prev = config[row.key];
	const next = typeof prev === "boolean" ? value === "on" : typeof prev === "number" ? Number(value) : value;
	if (typeof prev === "number" && !Number.isFinite(next)) return config;
	return { ...config, [row.key]: next };
}
