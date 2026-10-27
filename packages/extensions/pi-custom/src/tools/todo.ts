// The todo tool, its list above the editor, and /todos.
//
// State follows the branch in tool results and automatic idle-reset entries.
// Start, compaction and tree navigation replay the latest snapshot; no separate
// task file needs synchronizing.

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	groupProgress, pauseActive, reduce, replay,
	type Todo, type TodoParams, type TodoState, type TodoWidgetRow,
	widgetLines, widgetRows,
} from "./todo-state.ts";

const WIDGET_KEY = "pi-custom:todos";
const MAX_WIDGET_LINES = 12;
const COMPLETED_GRACE_MS = 60_000;
const MAINTENANCE_COOLDOWN_MS = 10 * 60_000;
const MAINTENANCE_MESSAGE = "pi-custom:todo-maintenance";
const MAINTENANCE_CONTINUATION = "Todo maintenance is optional bookkeeping, not a new user request. " +
	"After any cleanup, continue the already-authorized work in the same run; do not end with a cleanup-only final response. " +
	"If that work is complete, blocked, or waiting for input, retain that state rather than restarting it merely to prune tasks.";

export interface TodoClock {
	now(): number;
	schedule(callback: () => void, delay: number): () => void;
}

const CLOCK: TodoClock = {
	now: Date.now,
	schedule(callback, delay) {
		const timer = setTimeout(callback, delay);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

const GUIDELINES = [
	MAINTENANCE_CONTINUATION,
	"Use `todo` proactively for substantial multi-step work: multiple deliverables, platforms, implementation stages, or verification gates. Do not wait to be asked. After enough initial inspection to identify the work, populate the list before substantive implementation. Skip single-step edits, quick lookups, and conversation; respect an explicit request not to use todos.",
	"Each task must describe one independently verifiable outcome, not the whole request. Split implementation, distinct platform/feature acceptance checks, and authorized release work when they can succeed or fail separately. For example, use 'Verify Linux packaging' and 'Verify Mac clipboard' rather than 'Implement everything and verify Linux and Mac'. When an umbrella goal helps organize the work, convert it to a group (kind: group) and attach concrete child tasks with parentId. Otherwise replace it with the milestones; never keep a duplicate whole-goal task active alongside them. Avoid one task per shell command.",
	"Grouping is optional and limited to one level: top-level groups contain tasks, never other groups or grandchildren. Keep small lists flat. Group progress is derived from live children and groups are excluded from task totals; do not mark a group in_progress/completed yourself. Put any final audit in a child task. Hierarchy does not imply blockedBy dependencies, which must reference tasks, not groups. Set parentId to null to detach a task; move or delete children before deleting a group.",
	"A todo list is execution bookkeeping, not an opt-in design exercise or written plan. Maintain it without asking permission to track already authorized work. It does not authorize extra scope, delegation, commits, or publishing.",
	"Keep the list aligned with remaining work as requirements change. On resuming after compaction or a long interruption, inspect the existing todos with list/get and reconcile them with current evidence instead of creating duplicates or trusting stale completion claims. Use descriptions for acceptance criteria, verification evidence, and concrete blockers; do not bury distinct milestones in one description.",
	"Mark a task in_progress before working on it and completed as soon as its acceptance criteria are verified; never batch completions at the end. Starting a task returns other active tasks to pending unless they have distinct explicit owners for genuinely concurrent work. Settling or restoring a session pauses unfinished tasks so they do not look active forever. Before yielding, record next actions, blockers, and any running background job IDs in descriptions; job status is separate from active agent work. Work waiting on a blocker stays unfinished: record the blocker and next action, and leave it pending when you move to other work. Create a separate blocker-resolution task only if it is actionable work.",
	"A timeout, failed test, partial implementation, or unperformed manual/remote check is not completion. Keep that milestone unfinished with the evidence and blocker recorded; completed implementation must not hide outstanding verification.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

const ACTION_GLYPH: Record<string, string> = { create: "+", update: "→", delete: "×", get: "›", list: "☰", clear: "∅" };
const STATUS_MARK: Record<string, [string, string, string]> = {
	pending: ["○", "dim", "pending"],
	in_progress: ["◐", "warning", "in progress"],
	completed: ["●", "success", "completed"],
	deleted: ["⊘", "muted", "deleted"],
};

export function registerTodo(pi: ExtensionAPI, clock: TodoClock = CLOCK): void {
	let state: TodoState = { tasks: [], nextId: 1 };
	// Display-only deadlines: task history and dependency evidence remain intact.
	const fading = new Map<number, number>();
	let cancelCleanup: (() => void) | undefined;
	let cancelMaintenance: (() => void) | undefined;
	let lastReminderAt: number | undefined;
	let pendingReminder: string | undefined;
	let lastContextReminder: string | undefined;
	const hidden = new Set<number>();
	let collapsed = false;
	const collapsedGroups = new Set<number>();
	// A click on the list shows every task in full, wrapped; another puts it back.
	let wrapped = false;
	let ctxRef: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;

	function maintenance() {
		const live = state.tasks.filter((t) => t.status !== "deleted");
		const tasks = live.filter((t) => t.kind !== "group");
		const completed = tasks.filter((t) => t.status === "completed");
		if (completed.length < 5 || (completed.length < 10 && completed.length * 2 < tasks.length)) return;
		const referenced = new Set(live.flatMap((t) => t.blockedBy ?? []));
		const candidates = completed.filter((t) => !referenced.has(t.id)).map((t) => t.id);
		if (!candidates.length) return;
		return { completed: completed.length, total: tasks.length, candidates };
	}

	function maintenanceText(current: NonNullable<ReturnType<typeof maintenance>>): string {
		return `[Internal bookkeeping—not a user request] Todo maintenance: ${current.completed} of ${current.total} tasks are completed. ` +
			`Candidates: ${current.candidates.slice(0, 20).map((id) => `#${id}`).join(", ")}. ` +
			"At a convenient boundary, use todo list/get to review the CURRENT list: these candidate IDs may be stale. " +
			"Use delete to tombstone completed tasks that are no longer needed. Preserve unfinished work, blockers, required evidence, " +
			"and tasks still referenced by a live blockedBy. Never mark work complete just to prune it, and do not use clear. " +
			"Remove an obsolete group only after its live children have been removed. This is bookkeeping, not a new task or permission for other actions. " + MAINTENANCE_CONTINUATION;
	}

	function scheduleMaintenance(): void {
		if (!ctxRef || !pi.getActiveTools().includes("todo") || !maintenance() || pendingReminder) {
			cancelMaintenance?.();
			cancelMaintenance = undefined;
			return;
		}
		if (cancelMaintenance) return;
		const delay = Math.max(COMPLETED_GRACE_MS, (lastReminderAt ?? -MAINTENANCE_COOLDOWN_MS) + MAINTENANCE_COOLDOWN_MS - clock.now());
		cancelMaintenance = clock.schedule(() => {
			cancelMaintenance = undefined;
			const current = maintenance();
			if (!ctxRef || !current || pendingReminder || !pi.getActiveTools().includes("todo")) return;
			pendingReminder = randomUUID();
			lastReminderAt = clock.now();
			pi.sendMessage({
				customType: MAINTENANCE_MESSAGE, display: false,
				content: maintenanceText(current),
				details: { ...current, reminderId: pendingReminder },
			}, { deliverAs: "followUp", triggerTurn: false });
		}, delay);
	}

	function acknowledgeMaintenance(ctx: ExtensionContext): void {
		// A queued follow-up is not yet on the branch. Only release the slot once
		// this exact reminder reached conversation history at a run boundary.
		if (pendingReminder && ctx.sessionManager.getBranch().some((entry) => entry.type === "custom_message" &&
			entry.customType === MAINTENANCE_MESSAGE && (entry.details as { reminderId?: string } | undefined)?.reminderId === pendingReminder)) {
			pendingReminder = undefined;
		}
		scheduleMaintenance();
	}

	function cleanCompleted(): void {
		cancelCleanup?.();
		cancelCleanup = undefined;
		const completed = new Set(state.tasks.filter((t) => t.status === "completed").map((t) => t.id));
		for (const id of hidden) if (!completed.has(id)) hidden.delete(id);
		for (const id of fading.keys()) if (!completed.has(id)) fading.delete(id);
		const now = clock.now();
		for (const id of completed) {
			if (hidden.has(id)) continue;
			const deadline = fading.get(id) ?? now + COMPLETED_GRACE_MS;
			if (deadline <= now) { hidden.add(id); fading.delete(id); }
			else fading.set(id, deadline);
		}
		if (fading.size && ctxRef?.mode === "tui") {
			cancelCleanup = clock.schedule(() => {
				cleanCompleted();
				show(ctxRef);
			}, Math.min(...fading.values()) - now);
		}
	}

	function pauseWork(ctx: ExtensionContext): void {
		if (!state.tasks.some((t) => t.kind !== "group" && t.status === "in_progress")) return;
		state = pauseActive(state);
		pi.appendEntry("pi-custom:todo-state", state);
		show(ctx);
	}

	function load(ctx: ExtensionContext, pause = false): void {
		state = replay(ctx.sessionManager.getBranch() as never);
		ctxRef = ctx;
		collapsedGroups.clear();
		if (pause) {
			cancelMaintenance?.();
			cancelMaintenance = undefined;
			lastReminderAt = undefined;
			pendingReminder = undefined;
			lastContextReminder = undefined;
			fading.clear();
			hidden.clear();
			pauseWork(ctx);
		}
		cleanCompleted();
		scheduleMaintenance();
		show(ctx);
	}

	function show(ctx: ExtensionContext | undefined): void {
		if (!ctx || ctx.mode !== "tui") return;
		const expanded = wrapped || ctx.ui.getToolsExpanded();
		const anything = state.tasks.some((t) => t.status !== "deleted" && (expanded || !hidden.has(t.id)));
		if (!anything) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			requestRender = undefined;
			return;
		}
		if (requestRender) {
			requestRender();
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				let rows: TodoWidgetRow[] = [];
				return {
					render: (width: number) => {
						rows = widgetRows(
							state, hidden, MAX_WIDGET_LINES, theme as never,
							wrapped || (ctxRef?.ui.getToolsExpanded() ?? false), wrapped ? width : undefined, collapsedGroups,
						);
						if (collapsed) rows = rows.length ? [rows[0], { text: theme.fg("dim", "└─ ctrl+shift+t to expand") }] : [];
						return [...rows.map((row) => row.text), ""].map((line) => truncateToWidth(line, width, "…"));
					},
					handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						if (collapsed) collapsed = false;
						else {
							const groupId = rows[event.y]?.groupId;
							if (groupId !== undefined) {
								if (collapsedGroups.has(groupId)) collapsedGroups.delete(groupId);
								else collapsedGroups.add(groupId);
							} else wrapped = !wrapped;
						}
						return { handled: true, render: true };
					},
					invalidate() {},
				};
			},
			{ placement: "aboveEditor" },
		);
	}

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Track substantial multi-step work proactively as separate, verifiable tasks, optionally under one level of groups with derived progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Task status: pending → in_progress → completed, plus deleted tombstone. Starting work pauses conflicting active tasks; session settlement pauses unfinished work. Keep progress, verification evidence, and blockers current; skip trivial single-step work.",
		promptSnippet: "Track separate verifiable milestones and keep multi-step progress current",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
			subject: Type.Optional(Type.String({ description: "Task or group subject line (required for create)" })),
			kind: Type.Optional(StringEnum(["task", "group"] as const, { description: "Create a task (default) or top-level group; update can convert an umbrella task to a group. Groups cannot become tasks." })),
			parentId: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Task parent group id (create/update). Groups cannot have parents; only one nesting level. Use null to detach." })),
			description: Type.Optional(Type.String({ description: "Long-form task description" })),
			activeForm: Type.Optional(
				Type.String({ description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')" }),
			),
			status: Type.Optional(
				StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
					description:
						"Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status.",
				}),
			),
			blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Initial blockedBy ids (create only)" })),
			addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids to add to blockedBy (update only, additive merge)" })),
			removeBlockedBy: Type.Optional(
				Type.Array(Type.Number(), { description: "Task ids to remove from blockedBy (update only, additive merge)" }),
			),
			owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
			metadata: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "Arbitrary metadata; pass null value for a key to delete that key on update",
				}),
			),
			id: Type.Optional(Type.Number({ description: "Task id (required for update, get, delete)" })),
			includeDeleted: Type.Optional(
				Type.Boolean({ description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false." }),
			),
		}),
		async execute(_id, params) {
			const outcome = reduce(state, params as TodoParams);
			state = outcome.state;
			if (params.action === "clear") {
				cancelMaintenance?.();
				cancelMaintenance = undefined;
				lastReminderAt = undefined;
				cancelCleanup?.();
				cancelCleanup = undefined;
				collapsedGroups.clear();
				hidden.clear();
				fading.clear();
			}
			return {
				content: [{ type: "text" as const, text: outcome.text }],
				details: { action: params.action, params, tasks: state.tasks, nextId: state.nextId, ...(outcome.error ? { error: outcome.error } : {}) },
			};
		},
		renderCall(args, theme) {
			const a = args as TodoParams;
			let text = `${theme.fg("toolTitle", theme.bold("todo "))}${theme.fg("muted", ACTION_GLYPH[a.action] ?? "")}`;
			const subject =
				a.action === "create"
					? a.subject && theme.fg("dim", ` ${a.subject}`)
					: a.id !== undefined
						? theme.fg("accent", ` ${state.tasks.find((t) => t.id === a.id)?.subject ?? `#${a.id}`}`)
						: a.action === "list" && a.status
							? theme.fg("muted", ` ${a.status}`)
							: "";
			return new Text(text + (subject || ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as { action?: string; params?: TodoParams; tasks?: Todo[]; error?: string } | undefined;
			if (d?.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
			if (d && ["create", "update", "delete"].includes(d.action ?? "")) {
				const task = d.params?.id !== undefined ? d.tasks?.find((t) => t.id === d.params?.id) : d.tasks?.at(-1);
				if (task?.kind === "group" && task.status !== "deleted") {
					const { done, total } = groupProgress({ tasks: d.tasks ?? [], nextId: 0 }, task.id);
					return new Text(theme.fg("muted", `group · ${done}/${total} completed`), 0, 0);
				}
				const mark = task ? STATUS_MARK[task.status] : undefined;
				if (mark) return new Text(theme.fg(mark[1] as never, `${mark[0]} ${mark[2]}`), 0, 0);
			}
			return new Text(theme.fg("success", "✓"), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show all todos; /todos <group-id> collapses or expands one group",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			const live = state.tasks.filter((t) => t.status !== "deleted");
			if (args.trim()) {
				const id = /^\d+$/.test(args.trim()) ? Number(args.trim()) : NaN;
				if (!live.some((t) => t.id === id && t.kind === "group")) {
					ctx.ui.notify("Usage: /todos [live group id]", "error");
					return;
				}
				if (collapsedGroups.has(id)) collapsedGroups.delete(id);
				else collapsedGroups.add(id);
				collapsed = false;
				for (const t of live) if (t.id === id || t.parentId === id) hidden.delete(t.id);
				cleanCompleted();
				show(ctx);
				return;
			}
			if (live.some((t) => t.kind === "group")) {
				ctx.ui.notify(widgetLines(state, new Set(), MAX_WIDGET_LINES, { fg: (_slot, text) => text }, true).join("\n"), "info");
				return;
			}
			if (live.length === 0) {
				ctx.ui.notify("No todos yet. Ask the agent to add some!", "info");
				return;
			}
			const count = (s: string) => live.filter((t) => t.status === s).length;
			const header = [
				count("completed") ? `${count("completed")}/${live.length} completed` : "",
				count("in_progress") ? `${count("in_progress")} in progress` : "",
				count("pending") ? `${count("pending")} pending` : "",
			]
				.filter(Boolean)
				.join(" · ");
			const section = (title: string, status: string, glyph: string) => {
				const rows = live.filter((t) => t.status === status);
				if (!rows.length) return [];
				return [
					`── ${title} ──`,
					...rows.map(
						(t) =>
							`  ${glyph} #${t.id} ${t.subject}${t.activeForm && status === "in_progress" ? ` (${t.activeForm})` : ""}${
								t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((b) => `#${b}`).join(",")}` : ""
							}`,
					),
				];
			};
			ctx.ui.notify(
				[header, ...section("Pending", "pending", "○"), ...section("In Progress", "in_progress", "◐"), ...section("Completed", "completed", "✓")].join(
					"\n",
				),
				"info",
			);
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Collapse or expand the todo list",
		handler: async () => {
			collapsed = !collapsed;
			requestRender?.();
		},
	});

	pi.on("context_with_system", (event) => {
		let reminderId: string | undefined;
		const messages = event.messages.filter((message) => {
			if (message.role !== "custom" || message.customType !== MAINTENANCE_MESSAGE) return true;
			const details = message.details as { reminderId?: unknown } | undefined;
			if (typeof details?.reminderId === "string" && details.reminderId.length > 0) reminderId = details.reminderId;
			return false;
		});
		if (messages.length === event.messages.length) return;
		const fresh = reminderId !== undefined && reminderId !== lastContextReminder;
		lastContextReminder = reminderId;
		const current = maintenance();
		if (fresh && current && pi.getActiveTools().includes("todo")) {
			// Keep the persisted receipt for auditing, but not as a new conversational
			// request. Reconstruct from live state; never promote arbitrary notice text.
			messages.push({ role: "system", content: maintenanceText(current), timestamp: clock.now() });
		}
		return { messages };
	});

	pi.on("before_agent_start", (event) => {
		if (!pi.getActiveTools().includes("todo")) return;
		// Pi omits tool promptGuidelines when --system-prompt is supplied.
		// Restore only missing rules, so default prompts and repeated runs dedupe.
		const missing = GUIDELINES.filter((rule) => !event.systemPrompt.includes(rule));
		if (missing.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n## Task progress\n${missing.map((rule) => `- ${rule}`).join("\n")}` };
	});

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		requestRender = undefined;
		load(ctx, true);
	});
	pi.on("session_compact", (_event, ctx) => load(ctx));
	pi.on("session_tree", (_event, ctx) => load(ctx, true));
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle()) {
			pauseWork(ctx);
			acknowledgeMaintenance(ctx);
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== "todo" || event.isError) return;
		scheduleMaintenance();
		cleanCompleted();
		show(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		acknowledgeMaintenance(ctx);
		for (const id of fading.keys()) hidden.add(id);
		fading.clear();
		cancelCleanup?.();
		cancelCleanup = undefined;
		show(ctx);
	});

	pi.on("session_shutdown", () => {
		cancelMaintenance?.();
		cancelMaintenance = undefined;
		cancelCleanup?.();
		cancelCleanup = undefined;
		ctxRef = undefined;
		requestRender = undefined;
	});
}
