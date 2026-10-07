// Runs of exploratory tool calls, folded into one line the way Claude Code
// folds them:
//
//   Thought for 9s, ran 2 shell commands, read 1 file
//
// A run is consecutive reads, searches, listings and inspecting shell commands
// (inspect.ts) inside one agent run. Prose, any other tool or shell command, a
// user message or anything else drawn in the transcript ends it. While the
// agent is still adding to a run, the line is in the present tense with what
// the latest call is doing under it, and counts up in place:
//
//   Running 3 shell commands, reading 1 file…
//     ⎿  $ rg -n foo src
//
// The cards never show on their own, so nothing appears only to fold away.
// The thinking that led to a run's calls is part of the run too: pi is told
// not to draw it (pi-patches.nix), and an opened run shows it on the panel.
//
// Pure: the model is fed messages (a session branch on load, stream events
// live) and answers what each tool row should draw. render.ts asks it; index.ts
// feeds it.

import type { UiTheme } from "./card.ts";
import { isInspection } from "./inspect.ts";

/**
 * The tools a run can be made of: pi's built-in read-only tools and bash. find
 * and grep are FFF's when that is on, under the same names. MCP tools stay
 * out: nothing says which of them only read.
 */
export const GROUPABLE_TOOLS: ReadonlySet<string> = new Set(["bash", "read", "grep", "find", "ls"]);

/** Whether a call joins a run: the read-only tools always, bash when its command only inspects. */
export function foldsCall(toolName: string, args: unknown): boolean {
	if (!GROUPABLE_TOOLS.has(toolName)) return false;
	if (toolName !== "bash") return true;
	const command = (args as { command?: unknown } | undefined)?.command;
	return typeof command === "string" && isInspection(command);
}

export interface RunCall {
	id: string;
	toolName: string;
	failed: boolean;
	args: Record<string, unknown>;
	/** The thinking that led to this call, after the call before it. */
	thinking: string[];
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
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
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

function argsOf(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export class RunModel {
	private byCall = new Map<string, ToolRun>();
	/** Calls seen that join no run: their cards stand on their own. */
	private standalone = new Set<string>();
	/** The run the next exploratory call joins; undefined after a break. */
	private current: ToolRun | undefined;
	private running = false;
	// Thinking since the last call or break, waiting for the call it led to.
	private pendingMs = 0;
	private pendingUnknown = false;
	private pendingThinking: string[] = [];

	/** Rebuild from a session branch. Everything in it has finished, so every run is closed. */
	load(entries: readonly EntryLike[]): void {
		this.byCall.clear();
		this.standalone.clear();
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
			const thought = part.thinking?.trim();
			if (thought) this.pendingThinking.push(thought);
			return;
		}
		if (part.type === "text") {
			if (part.text?.trim()) this.breakRun();
			return;
		}
		if (part.type !== "toolCall" || !part.id) return;
		if (this.byCall.has(part.id) || this.standalone.has(part.id)) return;
		if (!foldsCall(part.name ?? "", part.arguments)) {
			this.standalone.add(part.id);
			this.breakRun();
			return;
		}
		if (!this.current) {
			this.current = { id: part.id, calls: [], thinkingMs: 0, thinkingUnknown: false };
		}
		this.current.calls.push({
			id: part.id,
			toolName: part.name ?? "",
			failed: false,
			args: argsOf(part.arguments),
			thinking: this.pendingThinking,
		});
		this.current.thinkingMs += this.pendingMs;
		this.current.thinkingUnknown ||= this.pendingUnknown;
		this.resetThinking();
		this.byCall.set(part.id, this.current);
	}

	/**
	 * An assistant message is complete. One that failed or was aborted draws its
	 * error, which ends the run, and pi marks each of its calls failed, so they
	 * show.
	 */
	endAssistant(message: MessageLike): void {
		if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
		for (const part of partsOf(message)) if (part.type === "toolCall" && part.id) this.setFailed(part.id, true);
		this.breakRun();
	}

	setFailed(toolCallId: string, failed: boolean): void {
		const call = this.callOf(toolCallId);
		if (call) call.failed = failed;
	}

	/** A call began executing, with the arguments it runs with. */
	started(toolCallId: string, args: unknown): void {
		const call = this.callOf(toolCallId);
		if (call) call.args = argsOf(args);
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

	/**
	 * A call pi is drawing whose arguments are still streaming in: it may yet
	 * join a run, so it shows nothing until it is known. A bash call cannot be
	 * judged from half a command.
	 */
	isPending(toolCallId: string, toolName: string): boolean {
		return this.running && GROUPABLE_TOOLS.has(toolName) && !this.byCall.has(toolCallId) && !this.standalone.has(toolCallId);
	}

	/**
	 * Whether pi should leave out an assistant message's thinking because the
	 * run it led to has it: a message with no prose whose every call is in a
	 * run. While the agent works, calls not yet known and a message that has
	 * produced only thinking so far count as joining one, so thinking is held
	 * back rather than drawn and then taken away; it appears once prose or a
	 * call that stands alone says it belongs to no run.
	 */
	hidesThinking(message: MessageLike): boolean {
		const parts = partsOf(message);
		if (!parts.some((p) => p.type === "thinking" && p.thinking?.trim())) return false;
		if (parts.some((p) => p.type === "text" && p.text?.trim())) return false;
		const calls = parts.filter((p) => p.type === "toolCall");
		if (calls.length === 0) return this.running;
		return calls.every((p) => p.id !== undefined && (this.byCall.has(p.id) || this.isPending(p.id, p.name ?? "")));
	}

	private callOf(toolCallId: string): RunCall | undefined {
		return this.byCall.get(toolCallId)?.calls.find((c) => c.id === toolCallId);
	}

	private resetThinking(): void {
		this.pendingMs = 0;
		this.pendingUnknown = false;
		this.pendingThinking = [];
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
		// Parts arrive in order, so every part before the one streaming has
		// finished, and so has one that just ended: a call joins its run as soon
		// as its arguments are complete, not when the next part starts.
		this.feed(parts, i);
		if (event.type.endsWith("_end")) this.feed(parts, i + 1);
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
	/** Cards pi has expanded, by a click or ctrl+o. */
	private openCards = new Set<string>();
	/** Each card's last expanded state, so only a change is acted on. */
	private seenCards = new Map<string, boolean>();

	isExpanded(runId: string, global: boolean): boolean {
		this.sync(global);
		return this.overrides.get(runId) ?? global;
	}

	/** Note whether pi has a card expanded; renderResult hears it on every update. */
	setCardOpen(toolCallId: string, open: boolean): void {
		// pi re-renders a row for many reasons; only a change of state counts, so
		// a run folded on purpose is not reopened by the next repaint.
		if (this.seenCards.get(toolCallId) === open) return;
		this.seenCards.set(toolCallId, open);
		if (open) this.openCards.add(toolCallId);
		else this.openCards.delete(toolCallId);
	}

	/**
	 * Whether the run shows its cards. A card you opened, most often one whose
	 * output you were watching while it ran, keeps its run open after the run
	 * ends, until you collapse it; folding it away under you would hide what
	 * you chose to look at.
	 */
	isShown(run: ToolRun, global: boolean): boolean {
		return this.isExpanded(run.id, global) || run.calls.some((c) => this.openCards.has(c.id));
	}

	/** Open or fold a run from its line. Folding also lets go of any card that held it open. */
	toggle(run: ToolRun, global: boolean): void {
		const shown = this.isShown(run, global);
		this.overrides.set(run.id, !shown);
		if (shown) for (const call of run.calls) this.openCards.delete(call.id);
	}

	clear(): void {
		this.overrides.clear();
		this.openCards.clear();
		this.seenCards.clear();
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
	/** The agent is still adding to the run: its line is in the present tense. */
	live?: boolean;
	/** Draw the call's own card. */
	card: boolean;
	/** The run is expanded: its cards sit on the panel. */
	inPanel: boolean;
	/** The thinking to draw above the card on the panel. */
	thinking?: string[];
}

const STANDALONE: RowPlan = { card: true, inPanel: false };
const PENDING: RowPlan = { card: false, inPanel: false };

export function planRow(model: RunModel, toolCallId: string, toolName: string, expanded: (run: ToolRun) => boolean): RowPlan {
	const run = model.runOf(toolCallId);
	if (!run) return model.isPending(toolCallId, toolName) ? PENDING : STANDALONE;
	const open = expanded(run);
	const call = run.calls.find((c) => c.id === toolCallId);
	return {
		header: run.calls[0]?.id === toolCallId ? run : undefined,
		live: model.isOpen(run),
		// A failure is never folded away: it shows on its own even in a minimized run.
		card: open || call?.failed === true,
		inPanel: open,
		thinking: open ? call?.thinking : undefined,
	};
}

interface Clause {
	tools: string[];
	verb: string;
	/** The verb while the run is still open. */
	doing: string;
	one: string;
	many: string;
}

const CLAUSES: Clause[] = [
	{ tools: ["bash"], verb: "ran", doing: "running", one: "shell command", many: "shell commands" },
	{ tools: ["read"], verb: "read", doing: "reading", one: "file", many: "files" },
	{ tools: ["grep", "find"], verb: "searched", doing: "searching", one: "pattern", many: "patterns" },
	{ tools: ["ls"], verb: "listed", doing: "listing", one: "directory", many: "directories" },
];

export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The run's one line, dim with the numbers bold. No bullet: it is a fold, not
 * a call. Live, it is in the present tense and trails off; under the pointer
 * it brightens from dim to the text colour.
 */
export function runSummary(run: ToolRun, theme: UiTheme, hovered = false, live = false): string {
	const shade = hovered ? "text" : "dim";
	const dim = (text: string) => theme.fg(shade, text);
	const num = (text: string) => theme.bold(theme.fg(shade, text));
	const clauses: Array<[string, string, string]> = [];
	// Under a second rounds to nothing worth saying.
	if (!run.thinkingUnknown && Math.round(run.thinkingMs / 1000) > 0) {
		clauses.push([live ? "thinking for" : "thought for", formatDuration(run.thinkingMs), ""]);
	}
	for (const clause of CLAUSES) {
		const calls = run.calls.filter((c) => clause.tools.includes(c.toolName));
		if (calls.length === 0) continue;
		const failed = calls.filter((c) => c.failed).length;
		const noun = calls.length === 1 ? clause.one : clause.many;
		clauses.push([live ? clause.doing : clause.verb, String(calls.length), ` ${noun}${failed > 0 ? ` (${failed} failed)` : ""}`]);
	}
	const line = clauses
		.map(([verb, n, rest], i) => {
			const lead = i === 0 ? verb.charAt(0).toUpperCase() + verb.slice(1) : verb;
			return `${dim(`${i === 0 ? "" : ", "}${lead} `)}${num(n)}${rest ? dim(rest) : ""}`;
		})
		.join("");
	return live ? line + dim("…") : line;
}

const TITLE = /^\*\*([^*]+)\*\*$/;

/**
 * The thinking that led to a call, as rows: title-only thinking ("**Checking
 * config**") as its titles, one to a row, a list; fuller thinking as its
 * paragraphs with a blank row ("") between, as prose reads.
 */
export function thoughtLines(thinking: string[]): string[] {
	const blocks = thinking
		.map((text) => {
			const lines = text.split("\n").map((line) => line.trim());
			const filled = lines.filter(Boolean);
			if (filled.length > 0 && filled.every((line) => TITLE.test(line))) return { titles: true, lines: filled.map((line) => line.replace(TITLE, "$1")) };
			// One blank row for each run of blank lines, none at the ends.
			const prose = lines.filter((line, i) => line || lines[i - 1]);
			while (prose.at(-1) === "") prose.pop();
			return { titles: false, lines: prose };
		})
		.filter((block) => block.lines.length > 0);
	const rows: string[] = [];
	blocks.forEach((block, i) => {
		const previous = blocks[i - 1];
		if (previous && !(previous.titles && block.titles)) rows.push("");
		rows.push(...block.lines);
	});
	return rows;
}
