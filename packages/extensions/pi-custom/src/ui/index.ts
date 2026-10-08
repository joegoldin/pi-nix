// pi-custom's interface part: Claude Code-style tool cards, markdown touches, /ui,
// /context, @session: and @agent: references, FFF-backed search, and the
// prompt box.
//
// Registration happens in the factory because pi asks for renderers and tools
// before any session exists. Everything that needs a session, a terminal or a
// native index waits for session_start, and only the terminal UI gets the
// editor, the shimmer and the completer: print and RPC modes have none of the
// surfaces those draw on.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	buildSessionContext,
	CustomEditor,
	generateDiffString,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getLanguageFromPath,
	getSettingsListTheme,
	highlightCode,
	keyText,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type Component, SettingsList } from "@earendil-works/pi-tui";
import { createCompleter } from "./complete.ts";
import { loadConfig, saveConfig, type UiConfig } from "./config.ts";
import { computeBreakdown, ContextView } from "./context.ts";
import { createPromptEditor, type EditorBase, sessionAccent, shimmerFrames } from "./editor.ts";
import { Framed } from "./frame.ts";
import { fileSuggestions, registerSearchTools, SearchIndex, trackSelection } from "./fff.ts";
import { type EntryLike, GroupState, LiveFeed, type MessageLike, RunModel } from "./group.ts";
import { HoverTracker, movesPointer } from "./hover.ts";
import { transformMarkdown } from "./markdown.ts";
import {
	type AgentSummary,
	agentDirs,
	loadAgents,
	referencesIn,
	type SessionSummary,
	sessionDigest,
} from "./references.ts";
import { createResolver } from "./render.ts";
import { applySetting, settingItems } from "./settings.ts";

const REFERENCE_TYPE = "pi-custom:reference";
// Where pi looks for whether to leave out an assistant message's thinking; the
// patch that reads it is in pi-patches.nix.
const HIDE_THINKING = Symbol.for("pi-custom.hideThinking");
// A write over a file larger than this shows the new content, not a diff: a
// diff of a file that size is not something to read in a transcript.
const PRIOR_MAX_BYTES = 2 * 1024 * 1024;
// Lists for the completer go stale slowly; re-reading them on every keystroke
// would hit the disk once per character typed after an @.
const LIST_TTL_MS = 15_000;

function cached<T>(load: () => T): { get(): T; clear(): void } {
	let value: T | undefined;
	let at = 0;
	return {
		get() {
			if (value === undefined || Date.now() - at > LIST_TTL_MS) {
				value = load();
				at = Date.now();
			}
			return value;
		},
		clear() {
			value = undefined;
		},
	};
}

/** A custom component that asks pi to repaint after each key it handles. */
function repainting(component: Component & { handleInput?(data: string): void }, requestRender: () => void): Component {
	return {
		render: (width) => component.render(width),
		invalidate: () => component.invalidate(),
		handleInput: (data) => {
			component.handleInput?.(data);
			requestRender();
		},
	};
}

export default function piUi(pi: ExtensionAPI): void {
	let config: UiConfig = loadConfig();
	const index = new SearchIndex();
	let ctxRef: ExtensionContext | undefined;
	let completerInstalled = false;
	// What each write call's target held before it ran. The write tool's result
	// does not say, and by the time the card draws, the file is already new.
	const priorContent = new Map<string, string | null>();

	// Runs of exploratory calls (group.ts): rebuilt from the branch whenever pi
	// redraws the transcript from it, then followed live.
	const runs = new RunModel();
	const feed = new LiveFeed(runs);
	const groups = new GroupState();
	const hover = new HoverTracker();
	// Any row's repaint asks pi for a frame, which redraws every row.
	let repaint: (() => void) | undefined;
	let stopWatchingPointer: (() => void) | undefined;

	pi.registerToolRenderer(
		createResolver({
			config: () => config,
			highlight: (code, lang) => highlightCode(code, lang),
			languageOf: (path) => getLanguageFromPath(path),
			expandKey: () => keyText("app.tools.expand"),
			diff: (oldContent, newContent) => generateDiffString(oldContent, newContent).diff,
			priorContent: (toolCallId) => priorContent.get(toolCallId),
			runs: { model: runs, groups, toolsExpanded: () => (ctxRef?.hasUI ? ctxRef.ui.getToolsExpanded() : false) },
			hover,
			noteRepaint: (fn) => {
				repaint = fn;
			},
		}),
	);

	function loadRuns(ctx: ExtensionContext): void {
		runs.load(ctx.sessionManager.getBranch() as EntryLike[]);
		groups.clear();
		hover.clear();
	}

	pi.on("session_tree", (_event, ctx) => loadRuns(ctx));
	pi.on("agent_start", () => runs.agentStart());
	pi.on("agent_end", () => {
		runs.agentEnd();
		// The last run folds now; pi may already have drawn its final frame.
		repaint?.();
	});
	pi.on("message_start", (event) => {
		if ((event.message as MessageLike).role === "assistant") feed.begin();
	});
	pi.on("message_update", (event) => {
		const message = event.message as MessageLike;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		feed.update(event.assistantMessageEvent, message.content);
	});
	pi.on("message_end", (event) => {
		const message = event.message as MessageLike;
		if (message.role === "assistant") feed.end(message);
		else runs.addMessage(message);
	});
	pi.on("tool_execution_start", (event) => {
		if (!event.parentToolCallId) runs.started(event.toolCallId, event.args);
	});
	pi.on("tool_execution_end", (event) => {
		if (!event.parentToolCallId) runs.setFailed(event.toolCallId, event.isError);
	});

	/**
	 * A folded run's thinking is part of the run: pi leaves it out of the
	 * assistant message, and an opened run draws it on its panel. Only while
	 * runs are drawn: with grouping or cards off, pi's thinking is all there is.
	 */
	function hideThinking(message: MessageLike): number[] {
		return config.groupRuns && config.toolMode !== "off" ? runs.hiddenThinking(message) : [];
	}

	/**
	 * Watch stdin for pointer reports to know when the pointer leaves every card
	 * (hover.ts says why pi's input listeners cannot see them). Read-only: pi's
	 * own reader still gets every byte.
	 */
	function watchPointer(): void {
		if (stopWatchingPointer) return;
		const onData = (chunk: string | Buffer) => {
			if (movesPointer(String(chunk))) setImmediate(() => hover.settle());
		};
		process.stdin.on("data", onData);
		stopWatchingPointer = () => process.stdin.off("data", onData);
	}

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write") return;
		const path = resolve(ctx.cwd, String((event.input as { path?: unknown }).path ?? ""));
		try {
			priorContent.set(
				event.toolCallId,
				existsSync(path) && statSync(path).size <= PRIOR_MAX_BYTES ? readFileSync(path, "utf8") : null,
			);
		} catch {
			// Unreadable before the write is the same as unknown: show the content.
		}
	});

	pi.registerMarkdownTransformer((markdown, context) => transformMarkdown(markdown, context, config));

	registerSearchTools(pi, index, () => config.fffSearch);

	const sessions = cached<Promise<SessionSummary[]>>(async () => {
		if (!ctxRef) return [];
		const infos = await SessionManager.list(ctxRef.cwd);
		return infos.map((s) => ({
			id: s.id,
			path: s.path,
			name: s.name,
			firstMessage: s.firstMessage,
			modified: s.modified,
			messageCount: s.messageCount,
		}));
	});

	const agents = cached<AgentSummary[]>(() => {
		if (!ctxRef) return [];
		// pi-subagents' own agents ship in its package; the subagent tool's
		// registration says where that package is.
		const tool = pi.getAllTools().find((t) => t.name === "subagent");
		const root = tool ? (tool.sourceInfo.baseDir ?? dirname(tool.sourceInfo.path)) : undefined;
		return loadAgents(agentDirs(root ? join(root, "agents") : undefined, ctxRef.cwd));
	});

	// References: the digest rides along with the prompt as its own message.
	pi.registerMessageRenderer(REFERENCE_TYPE, (message, options, theme) => {
		const details = (message.details ?? {}) as { label?: string };
		const content = typeof message.content === "string" ? message.content : "";
		const head = `${theme.fg("accent", "●")} ${theme.bold("Reference")}(${details.label ?? ""})`;
		const lines = options.expanded ? content.split("\n").map((l) => `     ${theme.fg("muted", l)}`) : [];
		return { render: () => [head, ...lines], invalidate() {} };
	});

	pi.on("input", async (event) => {
		const refs = referencesIn(event.text);
		if (refs.length === 0 || !ctxRef) return { action: "continue" };
		for (const ref of refs) {
			if (ref.kind === "session" && config.sessionReferences) {
				const info = (await sessions.get()).find((s) => s.id === ref.value || s.id.startsWith(ref.value));
				if (!info) continue;
				const sm = SessionManager.open(info.path);
				const { messages } = buildSessionContext(sm.getEntries(), sm.getLeafId());
				const label = info.name || info.firstMessage.slice(0, 50) || info.id;
				pi.sendMessage(
					{
						customType: REFERENCE_TYPE,
						content: `<referenced-session id="${info.id}" name="${label.replace(/"/g, "'")}">\n${sessionDigest(messages as never)}\n</referenced-session>`,
						display: true,
						details: { label: `session: ${label}` },
					},
					{ deliverAs: "nextTurn" },
				);
			} else if (ref.kind === "agent" && config.agentReferences) {
				if (!agents.get().some((a) => a.name === ref.value)) continue;
				pi.sendMessage(
					{
						customType: REFERENCE_TYPE,
						content: `The user referenced the "${ref.value}" subagent. Delegate this work to it with the subagent tool.`,
						display: true,
						details: { label: `agent: ${ref.value}` },
					},
					{ deliverAs: "nextTurn" },
				);
			}
		}
		return { action: "continue" };
	});

	pi.registerCommand("ui", {
		description: "pi-custom settings: tool cards, diffs, markdown, references, search",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const list = new SettingsList(
						settingItems(config),
						Math.max(5, Math.min(15, tui.terminal.rows - 8)),
						getSettingsListTheme(),
						(id, value) => {
							config = applySetting(config, id, value);
							saveConfig(config);
							applyLive(ctx);
						},
						() => done(),
						{ enableSearch: true },
					);
					return repainting(new Framed(list, "pi-custom", theme), () => tui.requestRender());
				},
				// In the editor's place, as pi's own /settings is: pi's inline
				// terminal does not repaint the rows an overlay covered once it closes.
			);
		},
	});

	pi.registerCommand("context", {
		description: "Where the context window is going",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			const options = ctx.getSystemPromptOptions?.();
			const active = new Set(pi.getActiveTools());
			const usage = ctx.getContextUsage();
			const breakdown = computeBreakdown({
				systemPrompt: ctx.getSystemPrompt(),
				contextFiles: options?.contextFiles ?? [],
				skills: options?.skills ?? [],
				tools: pi.getAllTools().filter((t) => active.has(t.name)),
				messages: buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as never,
				usedTokens: usage?.tokens ?? null,
				contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
			});
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					// Four rows go to the frame and the preview's own header and footer.
					const view = new ContextView(breakdown, theme, () => Math.max(8, Math.floor(tui.terminal.rows * 0.6) - 4), () => done());
					return repainting(new Framed(view, "Context", theme), () => tui.requestRender());
				},
			);
		},
	});

	/** The pieces that follow a setting while the session runs. */
	function applyLive(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (config.promptIcon) {
			const Editor = createPromptEditor(CustomEditor as unknown as EditorBase, () =>
				ctx.ui.theme.getThinkingBorderColor(pi.getThinkingLevel()),
			);
			ctx.ui.setEditorComponent((tui, theme, keybindings) => new Editor(tui, theme, keybindings) as never);
		} else {
			ctx.ui.setEditorComponent(undefined);
		}
		if (config.shimmer) {
			const accent = sessionAccent(ctx.sessionManager.getSessionId());
			ctx.ui.setWorkingIndicator({ frames: shimmerFrames("Working…", ctx.ui.theme, accent), intervalMs: 80 });
			// The frames carry the word; pi's own message would repeat it.
			ctx.ui.setWorkingMessage("");
		} else {
			ctx.ui.setWorkingIndicator();
			ctx.ui.setWorkingMessage();
		}
		if (config.fffSearch && !index.finder) index.open(ctx.cwd, getAgentDir());
		if (!config.fffSearch) index.close();
	}

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		sessions.clear();
		agents.clear();
		loadRuns(ctx);
		if (config.fffSearch) index.open(ctx.cwd, getAgentDir());
		if (ctx.mode !== "tui") return;
		(globalThis as Record<symbol, unknown>)[HIDE_THINKING] = hideThinking;
		applyLive(ctx);
		watchPointer();
		// The completer wraps whatever is installed; installing it again on the
		// next session_start would wrap it around itself.
		if (!completerInstalled) {
			completerInstalled = true;
			ctx.ui.addAutocompleteProvider(
				createCompleter({
					sessionsEnabled: () => config.sessionReferences,
					agentsEnabled: () => config.agentReferences,
					files: (query) => (config.fffSearch && index.finder ? fileSuggestions(index, query) : undefined),
					sessions: () => sessions.get(),
					agents: () => agents.get(),
					currentSessionId: () => ctxRef?.sessionManager.getSessionId(),
					trackFile: (query, value) => trackSelection(index, query, value),
				}),
			);
		}
	});

	pi.on("session_shutdown", () => {
		// Left behind, pi would keep asking a model nothing feeds any more.
		if ((globalThis as Record<symbol, unknown>)[HIDE_THINKING] === hideThinking) {
			delete (globalThis as Record<symbol, unknown>)[HIDE_THINKING];
		}
		priorContent.clear();
		stopWatchingPointer?.();
		stopWatchingPointer = undefined;
		repaint = undefined;
		index.close();
		ctxRef = undefined;
	});
}
