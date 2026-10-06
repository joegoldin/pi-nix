// Runs of exploratory tool calls, folded into one line the way Claude Code
// folds them:
//
//   Thought for 9s, ran 2 shell commands, read 1 file
//
// A run is consecutive reads, searches, listings and shell commands inside one
// agent run. Prose, any other tool, a user message or anything else drawn in
// the transcript ends it. While the agent is still adding to a run it stays
// open and every card shows, so progress is visible; once it closes it folds
// into the line above, unless you opened it.
//
// Pure: the model is fed messages (a session branch on load, stream events
// live) and answers what each tool row should draw. render.ts asks it; index.ts
// feeds it.

import type { UiTheme } from "./card.ts";

/**
 * The tools a run is made of: pi's built-in read-only tools and bash. find and
 * grep are FFF's when that is on, under the same names. MCP tools stay out:
 * nothing says which of them only read.
 */
export const GROUPABLE_TOOLS: ReadonlySet<string> = new Set(["bash", "read", "grep", "find", "ls"]);

export interface RunCall {
	id: string;
	toolName: string;
	failed: boolean;
}

export interface ToolRun {
	/** The first call's id: stable for the run's life, and what its expanded state is stored under. */
	id: string;
	calls: RunCall[];
	/** Thinking measured live before the run's calls, in ms. */
	thinkingMs: number;
	/** Thinking seen that was not measured (a session read back from disk): the run then claims no time at all. */
	thinkingUnknown: boolean;
}

interface PartLike {
	type: string;
	text?: string;
	id?: string;
	name?: string;
}

/** The fields of pi's AgentMessage the model reads. */
export interface MessageLike {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	isError?: boolean;
	display?: boolean;
	stopReason?: string;
}

/** The fields of a session entry the model reads. */
export interface EntryLike {
	type: string;
	message?: MessageLike;
	display?: boolean;
}

function partsOf(message: MessageLike): PartLike[] {
	return Array.isArray(message.content) ? (message.content as PartLike[]) : [];
}

export class RunModel {
	private byCall = new Map<string, ToolRun>();
	/** The run the next exploratory call joins; undefined after a break. */
	private current: ToolRun | undefined;
	private running = false;
	// Thinking since the last call or break, waiting for the call it led to.
	private pendingMs = 0;
	private pendingUnknown = false;

	/** Rebuild from a session branch. Everything in it has finished, so every run is closed. */
	load(entries: readonly EntryLike[]): void {
		this.byCall.clear();
		this.current = undefined;
		this.running = false;
		this.resetThinking();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message) this.addMessage(entry.message);
			// What pi draws between messages ends a run; model changes and the like draw nothing.
			else if (entry.type === "compaction" || entry.type === "branch_summary") this.breakRun();
			else if (entry.type === "custom_message" && entry.display) this.breakRun();
		}
		this.breakRun();
	}

	/** A whole message, as a session branch holds it. Live assistant messages arrive part by part instead. */
	addMessage(message: MessageLike): void {
		switch (message.role) {
			case "assistant":
				for (const part of partsOf(message)) this.addPart(part);
				this.endAssistant(message);
				return;
			case "toolResult":
				if (message.toolCallId) this.setFailed(message.toolCallId, message.isError === true);
				return;
			case "custom":
				if (message.display) this.breakRun();
				return;
			default:
				// user, bashExecution, summaries: all drawn between tool rows.
				this.breakRun();
		}
	}

	/** One finished part of an assistant message, with its thinking time when it was measured. */
	addPart(part: PartLike, thinkingMs?: number): void {
		if (part.type === "thinking") {
			if (thinkingMs === undefined) this.pendingUnknown = true;
			else this.pendingMs += thinkingMs;
			return;
		}
		if (part.type === "text") {
			if (part.text?.trim()) this.breakRun();
			return;
		}
		if (part.type !== "toolCall" || !part.id) return;
		if (!GROUPABLE_TOOLS.has(part.name ?? "")) {
			this.breakRun();
			return;
		}
		if (this.byCall.has(part.id)) return;
		if (!this.current) {
			this.current = { id: part.id, calls: [], thinkingMs: 0, thinkingUnknown: false };
		}
		this.current.calls.push({ id: part.id, toolName: part.name ?? "", failed: false });
		this.current.thinkingMs += this.pendingMs;
		this.current.thinkingUnknown ||= this.pendingUnknown;
		this.resetThinking();
		this.byCall.set(part.id, this.current);
	}

	/** An assistant message is complete. One that failed or was aborted draws its error, which ends the run. */
	endAssistant(message: MessageLike): void {
		if (message.stopReason === "error" || message.stopReason === "aborted") this.breakRun();
	}

	setFailed(toolCallId: string, failed: boolean): void {
		const call = this.byCall.get(toolCallId)?.calls.find((c) => c.id === toolCallId);
		if (call) call.failed = failed;
	}

	breakRun(): void {
		this.current = undefined;
		this.resetThinking();
	}

	agentStart(): void {
		this.running = true;
	}

	/** The agent stopped: whatever run it was adding to is finished. */
	agentEnd(): void {
		this.running = false;
		this.breakRun();
	}

	runOf(toolCallId: string): ToolRun | undefined {
		return this.byCall.get(toolCallId);
	}

	/** Still being added to: the agent is working and nothing has followed the run's last call. */
	isOpen(run: ToolRun): boolean {
		return this.running && run === this.current;
	}

	private resetThinking(): void {
		this.pendingMs = 0;
		this.pendingUnknown = false;
	}
}

/** The stream events LiveFeed reads, as pi's message_update carries them. */
export interface StreamEventLike {
	type: string;
	contentIndex?: number;
	delta?: string;
}

/**
 * Feeds a streaming assistant message into the model a part at a time, so a
 * run closes the moment prose starts rather than when its message ends, and
 * times each thinking block between its start and end events.
 */
export class LiveFeed {
	private done = 0;
	private thinkingStart = new Map<number, number>();
	private thinkingMs = new Map<number, number>();

	constructor(
		private model: RunModel,
		private now: () => number = Date.now,
	) {}

	begin(): void {
		this.done = 0;
		this.thinkingStart.clear();
		this.thinkingMs.clear();
	}

	update(event: StreamEventLike, parts: readonly PartLike[]): void {
		const i = event.contentIndex;
		if (i === undefined) return;
		if (event.type === "thinking_start") this.thinkingStart.set(i, this.now());
		if (event.type === "thinking_end") {
			const start = this.thinkingStart.get(i);
			if (start !== undefined) this.thinkingMs.set(i, this.now() - start);
		}
		// Parts arrive in order, so every part before the one streaming has finished.
		this.feed(parts, i);
		if (event.type === "text_delta" && parts[i]?.text?.trim()) this.feed(parts, i + 1);
	}

	end(message: MessageLike): void {
		const parts = partsOf(message);
		this.feed(parts, parts.length);
		this.model.endAssistant(message);
		this.begin();
	}

	private feed(parts: readonly PartLike[], upto: number): void {
		for (; this.done < Math.min(upto, parts.length); this.done++) {
			this.model.addPart(parts[this.done], this.thinkingMs.get(this.done));
		}
	}
}

/**
 * Which runs are expanded. A click sets one run; ctrl+o, which pi applies to
 * every tool row at once, resets them all to the new global state, the same
 * way it overrides a card you clicked open.
 */
export class GroupState {
	private overrides = new Map<string, boolean>();
	private lastGlobal: boolean | undefined;

	isExpanded(runId: string, global: boolean): boolean {
		this.sync(global);
		return this.overrides.get(runId) ?? global;
	}

	toggle(runId: string, global: boolean): void {
		this.overrides.set(runId, !this.isExpanded(runId, global));
	}

	clear(): void {
		this.overrides.clear();
		this.lastGlobal = undefined;
	}

	private sync(global: boolean): void {
		if (this.lastGlobal !== undefined && this.lastGlobal !== global) this.overrides.clear();
		this.lastGlobal = global;
	}
}

/** What one tool row draws. */
export interface RowPlan {
	/** Set on the run's first row: draw the run's line above the card. */
	header?: ToolRun;
	/** Draw the call's own card. */
	card: boolean;
	/** The run is expanded: its cards sit on the panel. */
	inPanel: boolean;
}

const STANDALONE: RowPlan = { card: true, inPanel: false };

export function planRow(model: RunModel, toolCallId: string, expanded: (run: ToolRun) => boolean): RowPlan {
	const run = model.runOf(toolCallId);
	if (!run || model.isOpen(run)) return STANDALONE;
	const open = expanded(run);
	const call = run.calls.find((c) => c.id === toolCallId);
	return {
		header: run.calls[0]?.id === toolCallId ? run : undefined,
		// A failure is never folded away: it shows on its own even in a minimized run.
		card: open || call?.failed === true,
		inPanel: open,
	};
}

interface Clause {
	tools: string[];
	verb: string;
	one: string;
	many: string;
}

const CLAUSES: Clause[] = [
	{ tools: ["bash"], verb: "ran", one: "shell command", many: "shell commands" },
	{ tools: ["read"], verb: "read", one: "file", many: "files" },
	{ tools: ["grep", "find"], verb: "searched", one: "pattern", many: "patterns" },
	{ tools: ["ls"], verb: "listed", one: "directory", many: "directories" },
];

export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The run's one line, dim with the numbers bold. No bullet: it is a fold, not a call. */
export function runSummary(run: ToolRun, theme: UiTheme): string {
	const dim = (text: string) => theme.fg("dim", text);
	const num = (text: string) => theme.bold(theme.fg("dim", text));
	const clauses: Array<[string, string, string]> = [];
	// Under a second rounds to nothing worth saying.
	if (!run.thinkingUnknown && Math.round(run.thinkingMs / 1000) > 0) {
		clauses.push(["thought for", formatDuration(run.thinkingMs), ""]);
	}
	for (const clause of CLAUSES) {
		const calls = run.calls.filter((c) => clause.tools.includes(c.toolName));
		if (calls.length === 0) continue;
		const failed = calls.filter((c) => c.failed).length;
		const noun = calls.length === 1 ? clause.one : clause.many;
		clauses.push([clause.verb, String(calls.length), ` ${noun}${failed > 0 ? ` (${failed} failed)` : ""}`]);
	}
	return clauses
		.map(([verb, n, rest], i) => {
			const lead = i === 0 ? verb.charAt(0).toUpperCase() + verb.slice(1) : verb;
			return `${dim(`${i === 0 ? "" : ", "}${lead} `)}${num(n)}${rest ? dim(rest) : ""}`;
		})
		.join("");
}
