// The todo list's state and the text the todo tool returns. Pure, so every
// transition and every message is testable without pi.
//
// Shapes and wording follow rpiv-todo: sessions recorded with it replay into
// this list. Tool results and idle-reset entries carry { tasks, nextId }.

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TodoAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Todo {
	id: number;
	subject: string;
	kind?: "task" | "group";
	parentId?: number;
	description?: string;
	acceptanceCriteria?: string;
	evidence?: string;
	activeForm?: string;
	status: TodoStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

export interface TodoState {
	tasks: Todo[];
	nextId: number;
}

export interface TodoParams {
	action: TodoAction;
	subject?: string;
	kind?: "task" | "group";
	parentId?: number | null;
	description?: string;
	acceptanceCriteria?: string;
	evidence?: string;
	activeForm?: string;
	status?: TodoStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
}

export const EMPTY: TodoState = { tasks: [], nextId: 1 };

const TRANSITIONS: Record<TodoStatus, TodoStatus[]> = {
	pending: ["in_progress", "completed", "deleted"],
	in_progress: ["pending", "completed", "deleted"],
	completed: ["deleted"],
	deleted: [],
};

/** Model text goes into a terminal; keep it to one plain line. */
export function sanitize(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/[\n\r\t\u2028\u2029]/g, " ")
		.replace(/[\x00-\x1f\x7f]/g, "");
}

function wouldCycle(tasks: Todo[], id: number, adding: number[]): boolean {
	const edges = new Map<number, number[]>(tasks.map((t) => [t.id, [...(t.blockedBy ?? [])]]));
	edges.set(id, [...(edges.get(id) ?? []), ...adding]);
	const stack = [...adding];
	const visited = new Set<number>();
	while (stack.length) {
		const n = stack.pop()!;
		if (n === id) return true;
		if (visited.has(n)) continue;
		visited.add(n);
		stack.push(...(edges.get(n) ?? []));
	}
	return false;
}

export interface Outcome {
	state: TodoState;
	text: string;
	error?: string;
}

const fail = (state: TodoState, error: string): Outcome => ({ state, text: `Error: ${error}`, error });

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function groupProgress(state: TodoState, id: number): { done: number; total: number; status: TodoStatus } {
	const children = state.tasks.filter((t) => t.parentId === id && t.status !== "deleted");
	const done = children.filter((t) => t.status === "completed").length;
	const status =
		children.length && done === children.length
			? "completed"
			: done || children.some((t) => t.status === "in_progress")
				? "in_progress"
				: "pending";
	return { done, total: children.length, status };
}

function deriveGroups(state: TodoState): TodoState {
	return {
		...state,
		tasks: state.tasks.map((t) =>
			t.kind === "group" && t.status !== "deleted" ? { ...t, status: groupProgress(state, t.id).status } : t,
		),
	};
}

/** Idle and restored sessions must not claim that an agent is still working. */
export function pauseActive(state: TodoState): TodoState {
	return deriveGroups({
		...state,
		tasks: state.tasks.map((t) => t.kind !== "group" && t.status === "in_progress" ? { ...t, status: "pending" as const } : t),
	});
}

function validateGrouping(tasks: Todo[]): string | undefined {
	for (const t of tasks.filter((t) => t.status !== "deleted")) {
		if (t.kind === "group" && t.parentId !== undefined) return "groups must be top-level; only one level of nesting is allowed";
		if (t.parentId !== undefined) {
			const parent = tasks.find((p) => p.id === t.parentId);
			if (!parent || parent.kind !== "group" || parent.status === "deleted") return `parentId: #${t.parentId} must be a live group`;
		}
		if (t.kind === "group" && t.blockedBy?.length) return "dependencies belong to tasks, not groups";
		if (t.blockedBy?.some((id) => tasks.find((dep) => dep.id === id)?.kind === "group")) return "dependencies must reference tasks, not groups";
	}
}

export function reduce(state: TodoState, p: TodoParams): Outcome {
	const outcome = reduceAction(state, p);
	if (outcome.error || outcome.state === state) return outcome;
	const error = validateGrouping(outcome.state.tasks);
	if (error) return fail(state, error);
	const active = p.action === "update" ? outcome.state.tasks.find((t) => t.id === p.id) : undefined;
	const paused: number[] = [];
	if (active?.kind !== "group" && active?.status === "in_progress") {
		outcome.state = {
			...outcome.state,
			tasks: outcome.state.tasks.map((t) => {
				if (t.id === active.id || t.kind === "group" || t.status !== "in_progress") return t;
				if (active.owner?.trim() && t.owner?.trim() && active.owner.trim() !== t.owner.trim()) return t;
				paused.push(t.id);
				return { ...t, status: "pending" as const };
			}),
		};
	}
	if (paused.length) outcome.text += `; returned ${paused.map((id) => `#${id}`).join(", ")} to pending`;
	return { ...outcome, state: deriveGroups(outcome.state) };
}

function reduceAction(state: TodoState, p: TodoParams): Outcome {
	const find = (id: number) => state.tasks.find((t) => t.id === id);
	switch (p.action) {
		case "create": {
			if (!p.subject?.trim()) return fail(state, "subject required for create");
			if (p.kind !== "group" && !p.acceptanceCriteria?.trim()) return fail(state, "acceptanceCriteria required for create: state the observable completion check");
			for (const b of p.blockedBy ?? []) {
				const dep = find(b);
				if (!dep) return fail(state, `blockedBy: #${b} not found`);
				if (dep.status === "deleted") return fail(state, `blockedBy: #${b} is deleted`);
			}
			const task: Todo = { id: state.nextId, subject: p.subject, status: "pending" };
			if (p.kind === "group") task.kind = "group";
			if (p.parentId != null) task.parentId = p.parentId;
			if (p.description) task.description = p.description;
			if (p.acceptanceCriteria?.trim()) task.acceptanceCriteria = p.acceptanceCriteria.trim();
			if (p.activeForm) task.activeForm = p.activeForm;
			if (p.blockedBy?.length) task.blockedBy = [...new Set(p.blockedBy)];
			if (p.owner) task.owner = p.owner;
			if (p.metadata && Object.keys(p.metadata).length) task.metadata = p.metadata;
			return {
				state: { tasks: [...state.tasks, task], nextId: state.nextId + 1 },
				text: `Created #${task.id}: ${sanitize(task.subject)} (pending)`,
			};
		}
		case "update": {
			if (p.id === undefined) return fail(state, "id required for update");
			const current = find(p.id);
			if (!current) return fail(state, `#${p.id} not found`);
			const mutable =
				p.kind !== undefined ||
				p.parentId !== undefined ||
				p.subject !== undefined ||
				p.description !== undefined ||
				p.acceptanceCriteria !== undefined ||
				p.evidence !== undefined ||
				p.activeForm !== undefined ||
				p.status !== undefined ||
				p.owner !== undefined ||
				p.metadata !== undefined ||
				(p.addBlockedBy?.length ?? 0) > 0 ||
				(p.removeBlockedBy?.length ?? 0) > 0;
			if (!mutable) {
				return fail(
					state,
					"update requires at least one mutable field: subject, kind, parentId, description, acceptanceCriteria, evidence, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy",
				);
			}
			if ((p.kind ?? current.kind) === "group" && p.status && p.status !== "deleted") return fail(state, "group status is derived from its children");
			if (current.kind === "group" && p.kind === "task") return fail(state, "groups cannot be converted to tasks; move their children instead");
			if (p.status && p.status !== current.status && !TRANSITIONS[current.status].includes(p.status)) {
				return fail(state, `illegal transition ${current.status} → ${p.status}`);
			}
			if (p.acceptanceCriteria !== undefined) {
				if (!p.acceptanceCriteria.trim()) return fail(state, "acceptanceCriteria must not be blank");
				if (current.acceptanceCriteria && p.acceptanceCriteria.trim() !== current.acceptanceCriteria) return fail(state, "acceptanceCriteria are stable; create a separate task for new scope or explicitly replace the obsolete task");
			}
			if (p.status === "completed" && current.status !== "completed" && !p.evidence?.trim()) return fail(state, "evidence required when completing a task: record the check and observed result");
			let blockedBy = (current.blockedBy ?? []).filter((b) => !(p.removeBlockedBy ?? []).includes(b));
			for (const b of p.addBlockedBy ?? []) {
				if (b === current.id) return fail(state, `cannot block #${b} on itself`);
				const dep = find(b);
				if (!dep) return fail(state, `addBlockedBy: #${b} not found`);
				if (dep.status === "deleted") return fail(state, `addBlockedBy: #${b} is deleted`);
			}
			const adding = (p.addBlockedBy ?? []).filter((b) => !blockedBy.includes(b));
			if (adding.length && wouldCycle(state.tasks, current.id, adding)) {
				return fail(state, "addBlockedBy would create a cycle in the blockedBy graph");
			}
			blockedBy = [...blockedBy, ...adding];
			const next: Todo = { ...current };
			if (p.subject !== undefined) next.subject = p.subject;
			if (p.kind !== undefined) next.kind = p.kind;
			if (p.parentId === null) delete next.parentId;
			else if (p.parentId !== undefined) next.parentId = p.parentId;
			if (p.description !== undefined) next.description = p.description;
			if (p.acceptanceCriteria !== undefined) next.acceptanceCriteria = p.acceptanceCriteria.trim();
			if (p.evidence !== undefined) next.evidence = p.evidence.trim();
			if (p.activeForm !== undefined) next.activeForm = p.activeForm;
			if (p.status !== undefined) next.status = p.status;
			if (p.owner !== undefined) next.owner = p.owner;
			if (p.metadata !== undefined) {
				const merged = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(p.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				if (Object.keys(merged).length) next.metadata = merged;
				else delete next.metadata;
			}
			if (blockedBy.length) next.blockedBy = blockedBy;
			else delete next.blockedBy;
			const changed = !sameJson(current, next);
			const tasks = state.tasks.map((t) => (t.id === current.id ? next : t));
			const text = !changed
				? `No change: #${current.id} already matches the requested values (status: ${current.status})`
				: next.status !== current.status
					? `Updated #${current.id} (${current.status} → ${next.status})`
					: `Updated #${current.id}`;
			return { state: { ...state, tasks }, text };
		}
		case "list": {
			const shown = state.tasks
				.filter((t) => p.includeDeleted === true || t.status !== "deleted")
				.filter((t) => !p.status || t.status === p.status);
			if (shown.length === 0) return { state, text: "No tasks" };
			return {
				state,
				text: shown
					.map((t) => {
						const progress = groupProgress(state, t.id);
						let line = t.kind === "group"
							? `[group ${t.status}] #${t.id} ${sanitize(t.subject)} (${progress.done}/${progress.total})`
							: `[${t.status}] #${t.id} ${sanitize(t.subject)}`;
						if (t.parentId !== undefined) line += ` (parent: #${t.parentId})`;
						if (t.kind !== "group" && t.status === "in_progress" && t.activeForm) line += ` (${sanitize(t.activeForm)})`;
						if (t.blockedBy?.length) line += ` ⛓ ${t.blockedBy.map((b) => `#${b}`).join(",")}`;
						return line;
					})
					.join("\n"),
			};
		}
		case "get": {
			if (p.id === undefined) return fail(state, "id required for get");
			const t = find(p.id);
			if (!t) return fail(state, `#${p.id} not found`);
			const blocks = state.tasks.filter((o) => o.blockedBy?.includes(t.id)).map((o) => `#${o.id}`);
			const lines = [`#${t.id} [${t.status}] ${sanitize(t.subject)}`];
			if (t.kind === "group") {
				const { done, total } = groupProgress(state, t.id);
				lines.push(`  group: ${done}/${total} completed (derived)`, `  children: ${state.tasks.filter((c) => c.parentId === t.id && c.status !== "deleted").map((c) => `#${c.id}`).join(", ") || "none"}`);
			}
			if (t.parentId !== undefined) lines.push(`  parent: #${t.parentId}`);
			if (t.acceptanceCriteria) lines.push(`  acceptanceCriteria: ${sanitize(t.acceptanceCriteria)}`);
			if (t.evidence) lines.push(`  evidence: ${sanitize(t.evidence)}`);
			if (t.description) lines.push(`  description: ${sanitize(t.description)}`);
			if (t.activeForm) lines.push(`  activeForm: ${sanitize(t.activeForm)}`);
			if (t.blockedBy?.length) lines.push(`  blockedBy: ${t.blockedBy.map((b) => `#${b}`).join(", ")}`);
			if (blocks.length) lines.push(`  blocks: ${blocks.join(", ")}`);
			if (t.owner) lines.push(`  owner: ${sanitize(t.owner)}`);
			return { state, text: lines.join("\n") };
		}
		case "delete": {
			if (p.id === undefined) return fail(state, "id required for delete");
			const t = find(p.id);
			if (!t) return fail(state, `#${p.id} not found`);
			if (t.status === "deleted") return fail(state, `#${p.id} is already deleted`);
			return {
				state: { ...state, tasks: state.tasks.map((o) => (o.id === t.id ? { ...o, status: "deleted" as const } : o)) },
				text: `Deleted #${t.id}: ${sanitize(t.subject)}`,
			};
		}
		case "clear": {
			const groups = state.tasks.filter((t) => t.kind === "group").length;
			return {
				state: { tasks: [], nextId: 1 },
				text: `Cleared ${state.tasks.length - groups} tasks${groups ? ` and ${groups} ${groups === 1 ? "group" : "groups"}` : ""}`,
			};
		}
	}
}

/** The latest todo state recorded on a branch, or the empty list. */
export function replay(entries: Array<{ type?: string; customType?: string; data?: unknown; message?: { role?: string; toolName?: string; details?: unknown } }>): TodoState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "custom" && entry.customType === "pi-custom:todo-state") {
			const d = entry.data as TodoState | undefined;
			if (Array.isArray(d?.tasks) && typeof d.nextId === "number") return deriveGroups(d);
		}
		const m = entry?.message;
		if (entries[i]?.type !== "message" || m?.role !== "toolResult" || m.toolName !== "todo") continue;
		const d = m.details as { tasks?: unknown; nextId?: unknown } | undefined;
		if (Array.isArray(d?.tasks) && typeof d?.nextId === "number") return deriveGroups({ tasks: d.tasks as Todo[], nextId: d.nextId });
	}
	return { tasks: [], nextId: 1 };
}

export interface WidgetTheme {
	fg(slot: string, text: string): string;
	strikethrough?(text: string): string;
}

const GLYPH: Record<Exclude<TodoStatus, "deleted">, [string, string]> = {
	pending: ["○", "dim"],
	in_progress: ["◐", "warning"],
	completed: ["✓", "success"],
};

export interface TodoWidgetRow {
	text: string;
	groupId?: number;
}

/** Logical rows retain group hit targets even when their text wraps. */
export function widgetRows(
	state: TodoState,
	hidden: Set<number>,
	maxLines: number,
	theme: WidgetTheme,
	showAll = false,
	width?: number,
	collapsedGroups = new Set<number>(),
): TodoWidgetRow[] {
	type Row = { task: Todo; parent?: Todo };
	const live = state.tasks.filter((t) => t.status !== "deleted");
	const blocks: Row[][] = [];
	for (const root of live.filter((t) => t.parentId === undefined)) {
		if (root.kind !== "group") {
			if (showAll || !hidden.has(root.id)) blocks.push([{ task: root }]);
			continue;
		}
		const children = live.filter((t) => t.parentId === root.id);
		const visible = children.filter((t) => showAll || !hidden.has(t.id));
		if (children.length && !visible.length) continue;
		if (!showAll && hidden.has(root.id) && !visible.some((t) => t.status !== "completed")) continue;
		blocks.push([{ task: root }, ...(collapsedGroups.has(root.id) ? [] : visible.map((task) => ({ task, parent: root })))]);
	}
	const visible = blocks.flat();
	if (!visible.length) return [];
	const leaves = live.filter((t) => t.kind !== "group");
	const done = leaves.filter((t) => t.status === "completed").length;
	const open = visible.some(({ task }) => task.status !== "completed");
	const lines: TodoWidgetRow[] = [{ text: `${theme.fg(open ? "accent" : "dim", open ? "●" : "○")} Todos (${done}/${leaves.length}) · ${done} complete · ${leaves.filter((t) => t.status === "in_progress").length} active · ${leaves.filter((t) => t.status === "pending").length} pending` }];
	if (width !== undefined && width < 70) lines[0].text = `${theme.fg(open ? "accent" : "dim", open ? "●" : "○")} Todos (${done}/${leaves.length})`;
	const budget = showAll ? visible.length : Math.max(3, maxLines) - 1;
	const overflow = visible.length > budget;
	const selected: Row[] = [];
	let remaining = overflow ? budget - 1 : budget;
	const unresolved = (t: Todo) => (t.blockedBy ?? []).filter((id) => {
		const dep = live.find((candidate) => candidate.id === id);
		return !dep || dep.status !== "completed";
	});
	const rank = (t: Todo): number => t.kind === "group"
		? Math.min(3, ...live.filter((child) => child.parentId === t.id).map(rank))
		: t.status === "completed" ? 3 : t.status === "in_progress" ? 0 : unresolved(t).length ? 2 : 1;
	const workFirst = (a: Row, b: Row) => rank(a.task) - rank(b.task);
	const ordered = [...blocks].sort((a, b) => workFirst(a[0], b[0]));
	for (const block of ordered) {
		// A group header always precedes its children, even when the budget cuts the block.
		if (!remaining) break;
		const sorted = block.length > 1 ? [block[0], ...block.slice(1).sort(workFirst)] : block;
		// When compact space is scarce, finished children must not displace
		// unfinished tasks in a later group or at the top level.
		const rows = overflow ? sorted.filter(({ task }) => task.status !== "completed") : sorted;
		const taken = rows.slice(0, remaining);
		selected.push(...taken);
		remaining -= taken.length;
	}
	const roots = selected.filter((row) => !row.parent);
	const showIds = live.some((t) => t.kind === "group" || t.blockedBy?.length);
	for (const row of selected) {
		const t = row.task;
		const root = row.parent ?? t;
		const lastRoot = roots.at(-1)?.task === root && !overflow;
		const siblings = selected.filter((r) => r.parent === row.parent);
		const last = row.parent ? siblings.at(-1) === row : lastRoot;
		const branch = row.parent ? (lastRoot ? "   " : "│  ") : "";
		const group = t.kind === "group";
		const completed = t.status === "completed";
		const [glyph, slot] = group ? [collapsedGroups.has(t.id) ? "▸" : "▾", completed ? "muted" : "accent"] : GLYPH[t.status as keyof typeof GLYPH];
		const subject = sanitize(t.subject);
		const body = completed ? theme.fg("muted", theme.strikethrough ? theme.strikethrough(subject) : subject)
			: group || t.status === "in_progress" ? theme.fg("accent", subject)
			: theme.fg("text", subject);
		let text = `${group && completed ? theme.fg("success", "✓ ") : ""}${showIds ? theme.fg("dim", `#${t.id} `) : ""}${body}`;
		if (group) {
			const { done, total } = groupProgress(state, t.id);
			text += theme.fg("muted", ` (${done}/${total})`);
		} else {
			if (t.status === "in_progress" && t.activeForm) text += theme.fg("muted", ` (${sanitize(t.activeForm)})`);
			const blockers = unresolved(t);
			if (blockers.length) text += theme.fg("muted", ` ⛓ ${blockers.map((b) => `#${b}`).join(",")}`);
		}
		const prefix = `${theme.fg("dim", branch + (last ? "└─" : "├─"))} ${theme.fg(slot, glyph)} `;
		const indent = theme.fg("dim", branch + (last ? " " : "│") + "    ");
		const parts = width === undefined ? [text] : wrapTextWithAnsi(text, Math.max(1, width - (row.parent ? 8 : 5)));
		parts.forEach((part, i) => lines.push({ text: (i === 0 ? prefix : indent) + part, ...(group ? { groupId: t.id } : {}) }));
	}
	if (overflow) {
		const rest = visible.filter((row) => !selected.includes(row));
		const tasks = rest.filter(({ task }) => task.kind !== "group");
		const groups = rest.length - tasks.length;
		const completed = tasks.filter(({ task }) => task.status === "completed").length;
		const summary = tasks.length ? `${tasks.length - completed} more unfinished${completed ? ` · ${completed} completed outside view` : ""}` : `+${groups} more groups`;
		lines.push({ text: theme.fg("dim", `└─ ${summary}`) });
	}
	return lines;
}

export function widgetLines(
	state: TodoState,
	hidden: Set<number>,
	maxLines: number,
	theme: WidgetTheme,
	showAll = false,
	width?: number,
	collapsedGroups = new Set<number>(),
): string[] {
	return widgetRows(state, hidden, maxLines, theme, showAll, width, collapsedGroups).map((row) => row.text);
}
