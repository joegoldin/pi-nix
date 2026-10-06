// The todo tool, its list above the editor, and /todos.
//
// State lives in the todo tool's own result details, so it follows the
// branch: on session start, compaction and tree navigation the list is
// replayed from the last todo result on the current branch. Nothing is
// written anywhere else.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { reduce, replay, type Todo, type TodoParams, type TodoState, widgetLines } from "./todo-state.ts";

const WIDGET_KEY = "pi-custom:todos";
const MAX_WIDGET_LINES = 12;

const GUIDELINES = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
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

export function registerTodo(pi: ExtensionAPI): void {
	let state: TodoState = { tasks: [], nextId: 1 };
	// Completed tasks shown during a turn disappear when the next one starts.
	const fading = new Set<number>();
	const hidden = new Set<number>();
	let collapsed = false;
	let ctxRef: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;

	function load(ctx: ExtensionContext): void {
		state = replay(ctx.sessionManager.getBranch() as never);
		fading.clear();
		hidden.clear();
		show(ctx);
	}

	function show(ctx: ExtensionContext | undefined): void {
		if (!ctx || ctx.mode !== "tui") return;
		const anything = state.tasks.some((t) => t.status !== "deleted" && !hidden.has(t.id));
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
				return {
					render: (width: number) => {
						const lines = collapsed
							? [
									widgetLines(state, hidden, MAX_WIDGET_LINES, theme as never)[0] ?? "",
									theme.fg("dim", "└─ ctrl+shift+t to expand"),
								]
							: widgetLines(state, hidden, MAX_WIDGET_LINES, theme as never, ctxRef?.ui.getToolsExpanded() ?? false);
						return [...lines, ""].map((l) => truncateToWidth(l, width, "…"));
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
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: "Manage a task list to track multi-step progress",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
			subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
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
				const mark = task ? STATUS_MARK[task.status] : undefined;
				if (mark) return new Text(theme.fg(mark[1] as never, `${mark[0]} ${mark[2]}`), 0, 0);
			}
			return new Text(theme.fg("success", "✓"), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			const live = state.tasks.filter((t) => t.status !== "deleted");
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

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		requestRender = undefined;
		load(ctx);
	});
	pi.on("session_compact", (_event, ctx) => load(ctx));
	pi.on("session_tree", (_event, ctx) => load(ctx));

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== "todo" || event.isError) return;
		for (const t of state.tasks) if (t.status === "completed") fading.add(t.id);
		show(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		for (const id of fading) hidden.add(id);
		fading.clear();
		show(ctx);
	});

	pi.on("session_shutdown", () => {
		ctxRef = undefined;
		requestRender = undefined;
	});
}
