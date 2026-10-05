// The @ completer: sessions, agents and files, layered over pi's own.
//
// pi stacks completers by wrapping: each factory receives the one before it.
// This one answers what it owns and hands everything else down unchanged, so
// slash commands, paths and whatever another extension added keep working.

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { agentSuggestions, keywordAt, referenceAt, sessionSuggestions, type AgentSummary, type SessionSummary, type Suggestion } from "./references.ts";

export interface CompleterSources {
	sessionsEnabled(): boolean;
	agentsEnabled(): boolean;
	/** Files ranked by FFF, or undefined when FFF is off or has no index. */
	files(query: string): Suggestion[] | undefined;
	sessions(): Promise<SessionSummary[]>;
	agents(): AgentSummary[];
	currentSessionId(): string | undefined;
	trackFile(query: string, value: string): void;
}

const KEYWORDS: Array<{ kind: "session" | "agent"; description: string }> = [
	{ kind: "session", description: "reference an earlier session" },
	{ kind: "agent", description: "name a subagent" },
];

function keywordItems(partial: string, sources: CompleterSources): AutocompleteItem[] {
	return KEYWORDS.filter((k) => (k.kind === "session" ? sources.sessionsEnabled() : sources.agentsEnabled()))
		.filter((k) => `${k.kind}:`.startsWith(partial))
		.map((k) => ({ value: `@${k.kind}:`, label: `@${k.kind}:`, description: k.description }));
}

const FILE_QUERY = /(?:^|\s)@"?([^\s"]*)$/;

export function createCompleter(sources: CompleterSources) {
	return (current: AutocompleteProvider): AutocompleteProvider => ({
		triggerCharacters: current.triggerCharacters,
		shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);

			const ref = referenceAt(before);
			if (ref) {
				const enabled = ref.kind === "session" ? sources.sessionsEnabled() : sources.agentsEnabled();
				if (enabled) {
					const items =
						ref.kind === "session"
							? sessionSuggestions(await sources.sessions(), ref.query, sources.currentSessionId())
							: agentSuggestions(sources.agents(), ref.query);
					return items.length ? { items, prefix: `@${ref.kind}:${ref.query}` } : null;
				}
			}

			const partial = keywordAt(before);
			const keywords = partial !== undefined ? keywordItems(partial, sources) : [];

			const fileQuery = FILE_QUERY.exec(before)?.[1];
			if (fileQuery !== undefined) {
				const files = sources.files(fileQuery);
				if (files) {
					const items = [...(fileQuery === partial ? keywords : []), ...files];
					return items.length ? { items, prefix: `@${fileQuery}` } : null;
				}
			}

			const theirs = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!keywords.length) return theirs;
			// Merge only when both answer the same typed prefix; otherwise one set
			// would be applied against the other's prefix.
			if (!theirs) return { items: keywords, prefix: `@${partial}` };
			return theirs.prefix === `@${partial}` ? { ...theirs, items: [...keywords, ...theirs.items] } : theirs;
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (/^@(session|agent):/.test(item.value)) {
				const line = lines[cursorLine] ?? "";
				const start = cursorCol - prefix.length;
				// A bare keyword keeps the cursor after the colon so the search can start.
				const insert = item.value.endsWith(":") ? item.value : `${item.value} `;
				const next = [...lines];
				next[cursorLine] = `${line.slice(0, start)}${insert}${line.slice(cursorCol)}`;
				return { lines: next, cursorLine, cursorCol: start + insert.length };
			}
			if (prefix.startsWith("@")) sources.trackFile(prefix.slice(1), item.value);
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	});
}
