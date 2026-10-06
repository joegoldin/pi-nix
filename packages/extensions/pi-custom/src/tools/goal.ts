// /goal: run one objective to completion across as many turns as it takes.
//
// The model is never vetoed when it stops; it is pushed. A goal turn that
// ends without goal_complete, goal_blocked or goal_wait is followed, once pi
// is idle, by a continuation prompt carrying the whole objective again. The
// loop ends only through those tools, or a safety pause: too many automatic
// turns, the same tool-free reply over and over, an exhausted token budget,
// Esc, or an error.
//
// The goal lives in a "goal-state" session entry, so it follows branches. A
// hidden "goal-contract" message states the current objective and goal_id to
// the model whenever it changes, and says goal mode is off once it ends, so a
// stale objective in the transcript never reads as current.

import { randomUUID } from "node:crypto";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { UiConfig } from "../ui/config.ts";
import {
	activeContract,
	BUDGET_WRAP_UP,
	CONTINUATION_MARKER,
	continuationPrompt,
	contradictsCompletion,
	editedPrompt,
	fingerprint,
	formatDuration,
	formatTokens,
	type Goal,
	type GoalStatus,
	INACTIVE_CONTRACT,
	kickoffPrompt,
	MAX_GOAL_ID,
	MIN_WAIT_MS,
	parseCommand,
	resumePrompt,
	statusText,
	waitingResumePrompt,
} from "./goal-text.ts";

const STATE_TYPE = "goal-state";
const CONTRACT_TYPE = "goal-contract";
const WRAP_UP_TYPE = "goal-budget-wrap-up";
const STATUS_KEY = "goal";

interface MessageLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface EntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
	content?: unknown;
	message?: MessageLike;
}

function assistantTokens(m: MessageLike): number {
	const u = m.usage;
	if (!u) return 0;
	if (typeof u.totalTokens === "number" && u.totalTokens >= 0) return u.totalTokens;
	return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

function branchTokens(ctx: ExtensionContext): number {
	let total = 0;
	for (const e of ctx.sessionManager.getBranch() as EntryLike[]) {
		if (e.type === "message" && e.message?.role === "assistant") total += assistantTokens(e.message);
	}
	return total;
}

function textOf(m: MessageLike | undefined): string {
	if (!m) return "";
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return (m.content as Array<{ type?: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

function isUsageLimit(message: string): boolean {
	return /usage limit|quota|insufficient[_ ]credit|billing|credit balance/i.test(message);
}

function isRetryable(message: string): boolean {
	return /overloaded|rate.?limit|\b429\b|\b5\d\d\b|timeout|timed out|network|ECONNRESET|stream ended|context length|context window/i.test(message);
}

export function registerGoal(pi: ExtensionAPI, config: () => UiConfig): void {
	let goal: Goal | undefined;
	let ctxRef: ExtensionContext | undefined;
	let lastContract: string | undefined;
	let runAutomatic = false;
	let runToolAttempted = false;
	let continuationWanted = false;
	let wrapUpSent = false;
	let wrapUpActive = false;
	let waitTimer: ReturnType<typeof setTimeout> | undefined;
	let completionTimer: ReturnType<typeof setTimeout> | undefined;

	const turnLimit = () => (config().goalTurnLimit > 0 ? config().goalTurnLimit : null);
	const noProgressLimit = () => (config().goalNoProgressTurns > 0 ? config().goalNoProgressTurns : null);

	function updateStatus(): void {
		try {
			ctxRef?.ui.setStatus(STATUS_KEY, statusText(goal, turnLimit()));
		} catch {}
	}

	function notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		try {
			ctxRef?.ui.notify(message, level);
		} catch {}
	}

	/** Bank the running clock and the tokens spent since the goal started. */
	function recordUsage(ctx: ExtensionContext, stopClock = false): void {
		if (!goal) return;
		const now = Date.now();
		if (goal.activeStartedAt) {
			goal.timeUsedSeconds += (now - goal.activeStartedAt) / 1000;
			goal.activeStartedAt = stopClock || goal.status !== "active" || goal.waiting ? undefined : now;
		}
		goal.tokensUsed = Math.max(0, branchTokens(ctx) - goal.baselineTokens);
		goal.updatedAt = now;
	}

	function persist(): void {
		pi.appendEntry(STATE_TYPE, { goal: goal ?? null });
		updateStatus();
	}

	function sendContract(content: string, details: unknown): void {
		if (lastContract === content) return;
		lastContract = content;
		pi.sendMessage({ customType: CONTRACT_TYPE, content, display: false, details }, { triggerTurn: false });
	}

	function deactivateContract(): void {
		if (lastContract !== undefined) sendContract(INACTIVE_CONTRACT, { version: 2, state: "inactive" });
	}

	function clearWait(): void {
		if (waitTimer) clearTimeout(waitTimer);
		waitTimer = undefined;
		if (goal?.waiting) {
			goal.waiting = undefined;
			if (goal.status === "active") goal.activeStartedAt = Date.now();
		}
	}

	function scheduleWait(): void {
		if (waitTimer) clearTimeout(waitTimer);
		waitTimer = undefined;
		const at = goal?.waiting?.resumeAt;
		if (at === undefined) return;
		waitTimer = setTimeout(() => {
			waitTimer = undefined;
			if (!goal || goal.status !== "active" || !goal.waiting) return;
			clearWait();
			continuationWanted = true;
			persist();
			dispatchIfSettled();
		}, Math.min(2 ** 31 - 1, Math.max(0, at - Date.now())));
	}

	/** Move the goal out of active, with the side effects every stop shares. */
	function stop(ctx: ExtensionContext, status: Exclude<GoalStatus, "active">, extra: Partial<Goal> = {}): void {
		if (!goal) return;
		recordUsage(ctx, true);
		continuationWanted = false;
		clearWait();
		goal = { ...goal, ...extra, status, activeStartedAt: undefined };
		persist();
		deactivateContract();
	}

	function clear(): void {
		if (waitTimer) clearTimeout(waitTimer);
		waitTimer = undefined;
		continuationWanted = false;
		wrapUpActive = false;
		goal = undefined;
		persist();
		deactivateContract();
	}

	function newGoal(ctx: ExtensionContext, text: string, budget?: number): Goal {
		const now = Date.now();
		return {
			id: randomUUID(),
			text,
			status: "active",
			startedAt: now,
			updatedAt: now,
			iteration: 0,
			tokenBudget: budget,
			tokensUsed: 0,
			baselineTokens: branchTokens(ctx),
			timeUsedSeconds: 0,
			activeStartedAt: now,
			automaticModelTurns: 0,
			toolFreeRepeatCount: 0,
		};
	}

	function resetSafety(): void {
		if (!goal) return;
		goal.automaticModelTurns = 0;
		goal.toolFreeRepeatCount = 0;
		goal.lastToolFreeFingerprint = undefined;
		goal.safetyPauseCause = undefined;
	}

	function budgetSpent(): boolean {
		return !!goal && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget;
	}

	function dispatchIfSettled(): void {
		const ctx = ctxRef;
		if (!ctx || !goal || goal.status !== "active" || goal.waiting || !continuationWanted) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		const limit = turnLimit();
		if (limit !== null && goal.automaticModelTurns >= limit) {
			pauseForSafety(ctx, "continuation_limit");
			return;
		}
		continuationWanted = false;
		try {
			pi.sendUserMessage(continuationPrompt(goal, randomUUID()), { deliverAs: "followUp" });
		} catch (err) {
			continuationWanted = true;
			notify(`Goal prompt failed: ${(err as Error).message}`, "error");
		}
	}

	function pauseForSafety(ctx: ExtensionContext, cause: "continuation_limit" | "no_progress"): void {
		if (!goal) return;
		const turns = goal.automaticModelTurns;
		const repeats = goal.toolFreeRepeatCount;
		stop(ctx, "paused", { safetyPauseCause: cause });
		notify(
			cause === "continuation_limit"
				? `Automatic-work limit reached: ${turns} of ${turnLimit()} responses. Goal progress is saved with ${formatTokens(goal?.tokensUsed ?? 0)} cumulative tokens. Open /goal to review and continue.`
				: `Goal paused: no progress across ${repeats} automatic runs; ${formatTokens(goal?.tokensUsed ?? 0)} cumulative tokens. Open /goal to review and continue.`,
			"warning",
		);
	}

	/** Send a prompt that starts or resumes goal work, as the user would. */
	function sendGoalPrompt(text: string): void {
		lastContract = undefined;
		pi.sendUserMessage(text, { deliverAs: "followUp" });
	}

	function summary(): string {
		if (!goal) return "Usage: /goal <objective>\nNo goal is currently set.";
		const limit = turnLimit();
		const elapsed = goal.timeUsedSeconds + (goal.activeStartedAt ? (Date.now() - goal.activeStartedAt) / 1000 : 0);
		return [
			`Goal: ${goal.text}`,
			`Status: ${goal.waiting ? "waiting" : goal.status}`,
			...(goal.waiting ? [`Waiting for: ${goal.waiting.reason}`, ...(goal.waiting.resumeAt ? [`Resumes by: ${new Date(goal.waiting.resumeAt).toISOString()}`] : [])] : []),
			`Iteration: ${goal.iteration}`,
			limit === null ? `Automatic work: ${goal.automaticModelTurns} responses · Unlimited` : `Automatic work: ${goal.automaticModelTurns} of ${limit} responses`,
			`Active time: ${formatDuration(elapsed)}`,
			`Tokens: ${goal.tokenBudget !== undefined ? `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}` : formatTokens(goal.tokensUsed)}`,
			...(goal.safetyPauseCause ? [`Paused by: ${goal.safetyPauseCause === "no_progress" ? "no-progress guard" : "automatic-work limit"}`] : []),
			goal.status === "active" ? "/goal pause · /goal edit · /goal clear" : "/goal resume · /goal edit · /goal clear",
		].join("\n");
	}

	// ---- tools ----

	const reject = (reason: string) => {
		notify(`Goal tool rejected: ${reason}`, "warning");
		return { content: [{ type: "text" as const, text: `Rejected: ${reason}` }], details: { rejected: reason } };
	};

	function checkId(id: string): string | undefined {
		if (!goal) return "no active goal";
		if (!id) return "missing goal_id";
		if (id.length > MAX_GOAL_ID) return "goal_id is too long";
		if (id !== goal.id) return "goal_id does not match the active goal";
		if (goal.status !== "active" && !wrapUpActive) return `goal is ${goal.status}, not active`;
		return undefined;
	}

	pi.registerTool({
		name: "goal_complete",
		label: "Goal Complete",
		description:
			"Mark an active /goal complete only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and every requirement is verified. Tool visibility alone does not activate Goal mode. Never call for ordinary work, partial progress, blockers, failures, or unverified work.",
		parameters: Type.Object({
			goal_id: Type.String({
				minLength: 1,
				maxLength: MAX_GOAL_ID,
				description: "The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
			}),
			summary: Type.String({
				minLength: 1,
				maxLength: 4000,
				description:
					"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const problem = checkId(params.goal_id);
			if (problem) return reject(problem);
			const text = params.summary.trim();
			if (!text) return reject("summary is empty");
			if (contradictsCompletion(text)) return reject("summary says the work is not complete");
			const finished = goal!;
			recordUsage(ctx, true);
			wrapUpActive = false;
			if (waitTimer) clearTimeout(waitTimer);
			goal = undefined;
			pi.appendEntry(STATE_TYPE, { goal: null });
			deactivateContract();
			try {
				ctxRef?.ui.setStatus(STATUS_KEY, "complete");
			} catch {}
			if (completionTimer) clearTimeout(completionTimer);
			completionTimer = setTimeout(() => updateStatus(), 8000);
			notify(`Goal complete: ${finished.text}`);
			return {
				content: [{ type: "text" as const, text: `Goal complete: ${text}` }],
				details: { goal: { ...finished, status: "complete", summary: text }, goal_id: finished.id, summary: text },
				terminate: true,
			};
		},
		renderResult(result) {
			const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
			if (!text.startsWith("Goal complete:")) return new Markdown(text, 0, 0, getMarkdownTheme());
			return new Markdown(`**Goal complete**\n\n${text.slice("Goal complete:".length).trim()}`, 0, 0, getMarkdownTheme());
		},
	});

	pi.registerTool({
		name: "goal_blocked",
		label: "Goal Blocked",
		description:
			"Stop an active /goal only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and the same evidenced external blocker recurred for at least three consecutive Goal turns. Tool visibility alone does not activate Goal mode. Never call for ordinary clarification, uncertainty, incomplete work, or recoverable failures.",
		parameters: Type.Object({
			goal_id: Type.String({ minLength: 1, maxLength: MAX_GOAL_ID, description: "The exact goal_id shown in the current active /goal prompt." }),
			reason: Type.String({ minLength: 1, maxLength: 1000, description: "The specific user or external action required to unblock the goal." }),
			evidence: Type.String({ minLength: 1, maxLength: 4000, description: "Concrete evidence from the repeated attempts that proves the impasse." }),
			repeated_turns: Type.Integer({ minimum: 3, description: "Number of separate turns spent trying to resolve this same blocker." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const problem = checkId(params.goal_id);
			if (problem) return reject(problem);
			if (!params.reason.trim() || !params.evidence.trim()) return reject("reason and evidence are required");
			if (!Number.isInteger(params.repeated_turns) || params.repeated_turns < 3) return reject("repeated_turns must be at least 3");
			stop(ctx, "blocked");
			notify(`Goal blocked: ${params.reason.slice(0, 160)}`, "warning");
			return {
				content: [{ type: "text" as const, text: `Goal blocked: ${params.reason}` }],
				details: { goal, goal_id: params.goal_id, reason: params.reason, evidence: params.evidence },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "goal_wait",
		label: "Goal Wait",
		description:
			"Keep an active /goal quiet only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and progress depends on an arranged external wake event or one safety deadline. Tool visibility alone does not activate Goal mode. Call goal_wait alone. Requests below 10000ms are clamped to 10000ms. Never call for ordinary unfinished work.",
		parameters: Type.Object({
			goal_id: Type.String({ minLength: 1, maxLength: MAX_GOAL_ID, description: "The exact goal_id shown in the current active /goal prompt." }),
			reason: Type.String({ minLength: 1, maxLength: 1000, description: "Why the goal is waiting and which external event should wake it." }),
			resume_after_ms: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 2147483647,
					description:
						"Optional safety deadline in milliseconds that requests one continuation if no wake message arrives. Values below 10000 are accepted but clamped to 10000.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const problem = checkId(params.goal_id);
			if (problem) return reject(problem);
			if (goal!.waiting) return reject("goal is already waiting");
			if (!params.reason.trim()) return reject("reason is required");
			recordUsage(ctx, true);
			continuationWanted = false;
			const requested = params.resume_after_ms;
			const effective = requested === undefined ? undefined : Math.max(MIN_WAIT_MS, requested);
			goal!.waiting = { reason: params.reason, ...(effective !== undefined ? { resumeAt: Date.now() + effective } : {}) };
			goal!.activeStartedAt = undefined;
			persist();
			scheduleWait();
			notify(`Goal waiting: ${params.reason}`);
			const clamped = requested !== undefined && effective !== requested ? `\nRequested resume_after_ms ${requested} was clamped to ${effective}.` : "";
			return {
				content: [{ type: "text" as const, text: `Goal waiting: ${params.reason}${clamped}` }],
				details: { goal, goal_id: params.goal_id, reason: params.reason, resume_after_ms: effective, resume_at: goal!.waiting.resumeAt },
				terminate: true,
			};
		},
	});

	// ---- /goal ----

	async function start(ctx: ExtensionContext, objective: string, budget: number | undefined): Promise<void> {
		const active = new Set(pi.getActiveTools());
		if (!active.has("goal_complete") || !active.has("goal_blocked")) {
			notify(
				"Cannot start /goal: goal_complete and goal_blocked are unavailable; include them in the active tool allowlist or leave the restrictive tool mode first.",
				"error",
			);
			return;
		}
		const replacing = goal && goal.status !== "complete";
		if (replacing && ctx.hasUI && !(await ctx.ui.confirm("Replace goal?", `Current goal: ${goal!.text}\n\nNew goal: ${objective}`))) {
			notify(`Goal kept: ${goal!.text}`);
			return;
		}
		clearWait();
		wrapUpSent = false;
		wrapUpActive = false;
		goal = newGoal(ctx, objective, budget);
		persist();
		sendGoalPrompt(kickoffPrompt(goal));
		const limit = turnLimit();
		notify(
			`${replacing ? "Goal replaced" : "Goal started"}: ${objective}. ${budget !== undefined ? `Token budget: ${formatTokens(budget)} cumulative; the final model call may exceed it. ` : ""}${
				limit === null
					? "Automatic work is Unlimited; tool loops may consume substantial tokens and provider cost. Open /goal to monitor."
					: `Automatic work pauses after ${limit} responses; open /goal to monitor progress.`
			}`,
			limit === null ? "warning" : "info",
		);
	}

	function resume(ctx: ExtensionContext): void {
		if (!goal) {
			notify("No active goal.");
			return;
		}
		if (goal.status === "active" && goal.waiting) {
			const reason = goal.waiting.reason;
			clearWait();
			persist();
			sendGoalPrompt(waitingResumePrompt(goal, reason));
			return;
		}
		if (goal.status === "active") {
			notify("Goal is already active.");
			return;
		}
		if (goal.status === "budget_limited" && budgetSpent()) {
			notify(`Goal token budget is still reached: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget ?? 0)}`, "warning");
			return;
		}
		const from = goal.status;
		goal = { ...goal, id: randomUUID(), status: "active", activeStartedAt: Date.now() };
		resetSafety();
		wrapUpActive = false;
		persist();
		sendGoalPrompt(resumePrompt(goal, from));
		notify(
			`Goal resumed from ${from.replace("_", "-")}: ${goal.text}. The automatic-work counter will reset to 0${turnLimit() === null ? "" : ` of ${turnLimit()}`} when the resumed prompt starts; goal progress and cumulative usage are preserved.`,
		);
	}

	function edit(ctx: ExtensionContext, objective: string, budget: number | undefined): void {
		if (!goal) {
			notify("No active goal.");
			return;
		}
		const nextBudget = budget ?? goal.tokenBudget;
		if (goal.status === "budget_limited" && (nextBudget === undefined || nextBudget <= goal.tokensUsed)) {
			notify("Raise the token budget above current usage to edit a budget-limited goal.", "warning");
			return;
		}
		recordUsage(ctx);
		continuationWanted = false;
		clearWait();
		const keep: GoalStatus[] = ["paused", "blocked", "usage_limited"];
		const status: GoalStatus = keep.includes(goal.status) ? goal.status : "active";
		goal = { ...goal, id: randomUUID(), text: objective, tokenBudget: nextBudget, status, activeStartedAt: status === "active" ? Date.now() : undefined };
		if (status === "active") resetSafety();
		persist();
		if (status === "active") sendGoalPrompt(editedPrompt(goal));
		notify(`Goal updated: ${objective}`);
	}

	async function menu(ctx: ExtensionContext): Promise<void> {
		const choices = !goal
			? ["Start a goal…", "Start with token budget…", "Settings…"]
			: [
					...(goal.status === "active" && !goal.waiting ? ["Pause goal"] : ["Resume goal"]),
					"Edit goal…",
					"View full status",
					"Clear goal…",
					"Settings…",
				];
		const title = goal ? `Goal · ${statusText(goal, turnLimit())}\n${goal.text.slice(0, 120)}` : "Goal · none";
		const picked = await ctx.ui.select(title, [...choices, "Close"]);
		if (!picked || picked === "Close") return;
		if (picked === "Pause goal") return pause(ctx);
		if (picked === "Resume goal") return resume(ctx);
		if (picked === "View full status") return notify(summary());
		if (picked === "Settings…") return notify("Goal limits live in /ui: /goal turn limit and /goal stall check.");
		if (picked === "Clear goal…") {
			if (await ctx.ui.confirm("Clear goal?", goal!.text)) {
				const text = goal!.text;
				clear();
				notify(`Goal cleared: ${text}`, "warning");
			}
			return;
		}
		if (picked === "Edit goal…") {
			const text = await ctx.ui.editor("Edit goal objective", goal!.text);
			if (text?.trim()) edit(ctx, text.trim(), undefined);
			return;
		}
		let budget: number | undefined;
		if (picked === "Start with token budget…") {
			const b = await ctx.ui.select("Token budget", ["25k — Lower token ceiling", "100k — Suggested", "300k — Higher token ceiling"]);
			if (!b) return;
			budget = { "25k": 25_000, "100k": 100_000, "300k": 300_000 }[b.split(" ")[0]];
		}
		const objective = await ctx.ui.editor("Goal objective", "");
		if (objective?.trim()) await start(ctx, objective.trim(), budget);
	}

	function pause(ctx: ExtensionContext): void {
		if (!goal || goal.status !== "active") {
			notify("Only an active goal can be paused.");
			return;
		}
		stop(ctx, "paused");
		try {
			ctx.abort();
		} catch {}
		notify(`Goal paused: ${goal?.text ?? ""}`);
	}

	pi.registerCommand("goal", {
		description: "Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return null;
			return ["pause", "resume", "clear", "edit", "status", "--tokens "]
				.filter((c) => c.startsWith(prefix))
				.map((c) => ({ value: c, label: c.trim(), ...(c === "--tokens " ? { description: "Set a token budget before the goal" } : {}) }));
		},
		handler: async (args, ctx) => {
			const cmd = parseCommand(args);
			switch (cmd.kind) {
				case "error":
					return notify(cmd.message, "warning");
				case "show":
					if (ctx.mode === "tui") return menu(ctx);
					return notify(summary());
				case "status":
					if (goal) {
						recordUsage(ctx);
						persist();
					}
					return notify(summary());
				case "pause":
					return pause(ctx);
				case "resume":
					return resume(ctx);
				case "clear": {
					if (!goal) return notify("No active goal.");
					const text = goal.text;
					clear();
					return notify(`Goal cleared: ${text}`, "warning");
				}
				case "edit":
					return edit(ctx, cmd.objective, cmd.budget);
				case "start":
					return start(ctx, cmd.objective, cmd.budget);
			}
		},
	});

	// ---- lifecycle ----

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		goal = undefined;
		lastContract = undefined;
		continuationWanted = false;
		wrapUpActive = false;
		wrapUpSent = false;
		const branch = ctx.sessionManager.getBranch() as EntryLike[];
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "custom" && e.customType === STATE_TYPE) {
				const saved = (e.data as { goal?: Goal | null } | undefined)?.goal;
				if (saved && saved.status !== "complete") goal = saved;
				break;
			}
		}
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "custom_message" && e.customType === CONTRACT_TYPE) {
				lastContract = typeof e.content === "string" ? e.content : textOf({ content: e.content });
				break;
			}
		}
		if (goal?.status === "active") {
			// Time offline is not time spent on the goal.
			goal.activeStartedAt = goal.waiting ? undefined : Date.now();
			scheduleWait();
		}
		updateStatus();
	});

	pi.on("input", (event) => {
		if (!goal || goal.status !== "active") return { action: "continue" as const };
		const text = event.text.trim();
		if (event.source !== "extension" && !text.startsWith("/goal")) {
			if (goal.waiting) {
				clearWait();
				persist();
			}
			// A person steering the work restarts the count toward a review pause.
			resetSafety();
		}
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", (event) => {
		runAutomatic = event.prompt.includes(`<!-- ${CONTINUATION_MARKER}:`);
		runToolAttempted = false;
		if (!goal || goal.status !== "active") return undefined;
		if (!runAutomatic) continuationWanted = false;
		const content = activeContract(goal);
		if (lastContract === content) return undefined;
		lastContract = content;
		return { message: { customType: CONTRACT_TYPE, content, display: false, details: { version: 2, state: "active", goalId: goal.id } } };
	});

	pi.on("tool_call", (event) => {
		runToolAttempted = true;
		if (wrapUpActive && event.toolName !== "goal_complete") {
			return { block: true, reason: "The /goal token budget is exhausted; only goal_complete is allowed while wrapping up." };
		}
		return undefined;
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (!goal || goal.status !== "active") return;
		recordUsage(ctx);
		if (budgetSpent() && !wrapUpSent) {
			wrapUpSent = true;
			wrapUpActive = true;
			goal.status = "budget_limited";
			persist();
			pi.sendMessage({ customType: WRAP_UP_TYPE, content: BUDGET_WRAP_UP, display: true, details: { goalId: goal.id } }, { deliverAs: "steer" });
		}
	});

	pi.on("turn_end", (event, ctx) => {
		if (!goal || goal.status !== "active" || !runAutomatic) return;
		if ((event.message as MessageLike).stopReason === "aborted") return;
		goal.automaticModelTurns++;
		recordUsage(ctx);
		persist();
	});

	pi.on("agent_end", (event, ctx) => {
		if (wrapUpActive) {
			wrapUpActive = false;
			if (goal) {
				recordUsage(ctx, true);
				persist();
				deactivateContract();
			}
			return;
		}
		if (!goal || goal.status !== "active" || goal.waiting) return;
		goal.iteration++;
		recordUsage(ctx);
		const last = [...(event.messages as MessageLike[])].reverse().find((m) => m.role === "assistant");
		if (last?.stopReason === "aborted") {
			stop(ctx, "paused");
			notify("Goal paused after interruption. Run /goal resume to continue.", "warning");
			return;
		}
		if (last?.stopReason === "error") {
			const message = last.errorMessage ?? "unknown error";
			// pi retries these itself; the goal waits for that rather than stopping.
			if (isRetryable(message)) return persist();
			if (isUsageLimit(message)) {
				stop(ctx, "usage_limited");
				notify(`Goal stopped after provider usage limit (${message}). Run /goal resume when usage is available.`, "warning");
			} else {
				stop(ctx, "blocked");
				notify(`Goal blocked after agent error (${message}). Resolve the blocker or run /goal resume to retry.`, "warning");
			}
			return;
		}
		if (runAutomatic) {
			if (runToolAttempted) {
				goal.toolFreeRepeatCount = 0;
				goal.lastToolFreeFingerprint = undefined;
			} else {
				const print = fingerprint(textOf(last));
				goal.toolFreeRepeatCount = print === goal.lastToolFreeFingerprint ? goal.toolFreeRepeatCount + 1 : 1;
				goal.lastToolFreeFingerprint = print;
				const limit = noProgressLimit();
				if (limit !== null && goal.toolFreeRepeatCount >= limit) {
					pauseForSafety(ctx, "no_progress");
					return;
				}
			}
		}
		persist();
		continuationWanted = true;
	});

	pi.on("agent_settled", () => dispatchIfSettled());

	pi.on("session_compact", () => {
		// Compaction may have summarised the contract away; restate it.
		if (goal?.status === "active") {
			lastContract = undefined;
			sendContract(activeContract(goal), { version: 2, state: "active", goalId: goal.id });
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (goal?.status === "active") {
			recordUsage(ctx, true);
			persist();
		}
		if (waitTimer) clearTimeout(waitTimer);
		if (completionTimer) clearTimeout(completionTimer);
		waitTimer = undefined;
		ctxRef = undefined;
	});
}
