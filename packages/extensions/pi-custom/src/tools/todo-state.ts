// The todo list's state and the text the todo tool returns. Pure, so every
// transition and every message is testable without pi.
//
// Shapes and wording follow rpiv-todo: sessions recorded with it replay into
// this list, because the state travels in each todo result's details as
// { tasks, nextId }.

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TodoAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Todo {
	id: number;
	subject: string;
	description?: string;
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
	description?: string;
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

export function reduce(state: TodoState, p: TodoParams): Outcome {
	const find = (id: number) => state.tasks.find((t) => t.id === id);
	switch (p.action) {
		case "create": {
			if (!p.subject?.trim()) return fail(state, "subject required for create");
			for (const b of p.blockedBy ?? []) {
				const dep = find(b);
				if (!dep) return fail(state, `blockedBy: #${b} not found`);
				if (dep.status === "deleted") return fail(state, `blockedBy: #${b} is deleted`);
			}
			const task: Todo = { id: state.nextId, subject: p.subject, status: "pending" };
			if (p.description) task.description = p.description;
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
				p.subject !== undefined ||
				p.description !== undefined ||
				p.activeForm !== undefined ||
				p.status !== undefined ||
				p.owner !== undefined ||
				p.metadata !== undefined ||
				(p.addBlockedBy?.length ?? 0) > 0 ||
				(p.removeBlockedBy?.length ?? 0) > 0;
			if (!mutable) {
				return fail(
					state,
					"update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy",
				);
			}
			if (p.status && p.status !== current.status && !TRANSITIONS[current.status].includes(p.status)) {
				return fail(state, `illegal transition ${current.status} → ${p.status}`);
			}
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
			if (p.description !== undefined) next.description = p.description;
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
						let line = `[${t.status}] #${t.id} ${sanitize(t.subject)}`;
						if (t.status === "in_progress" && t.activeForm) line += ` (${sanitize(t.activeForm)})`;
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
		case "clear":
			return { state: { tasks: [], nextId: 1 }, text: `Cleared ${state.tasks.length} tasks` };
	}
}

/** The latest todo state recorded on a branch, or the empty list. */
export function replay(entries: Array<{ type?: string; message?: { role?: string; toolName?: string; details?: unknown } }>): TodoState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i]?.message;
		if (entries[i]?.type !== "message" || m?.role !== "toolResult" || m.toolName !== "todo") continue;
		const d = m.details as { tasks?: unknown; nextId?: unknown } | undefined;
		if (Array.isArray(d?.tasks) && typeof d?.nextId === "number") return { tasks: d.tasks as Todo[], nextId: d.nextId };
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

/**
 * The widget above the editor: a heading, then the list, cutting completed
 * tasks first when it runs out of rows. `hidden` holds completed ids from an
 * earlier turn, which fade out once the next turn starts.
 */
// With a width, each task wraps under its subject instead of running off the
// edge to be cut.
export function widgetLines(
	state: TodoState,
	hidden: Set<number>,
	maxLines: number,
	theme: WidgetTheme,
	showAll = false,
	width?: number,
): string[] {
	const visible = state.tasks.filter((t) => t.status !== "deleted" && !hidden.has(t.id));
	if (visible.length === 0) return [];
	const done = state.tasks.filter((t) => t.status === "completed").length;
	const total = state.tasks.filter((t) => t.status !== "deleted").length;
	const open = visible.some((t) => t.status !== "completed");
	const lines = [`${theme.fg(open ? "accent" : "dim", open ? "●" : "○")} Todos (${done}/${total})`];
	const budget = showAll ? visible.length : Math.max(1, Math.max(3, maxLines) - 1);
	let rows = visible;
	if (rows.length > budget) {
		const unfinished = rows.filter((t) => t.status !== "completed");
		rows = unfinished.length >= budget ? unfinished.slice(0, budget - 1) : [...unfinished, ...rows.filter((t) => t.status === "completed")].slice(0, budget - 1);
	}
	const showIds = visible.some((t) => t.blockedBy?.length);
	rows.forEach((t, i) => {
		const last = i === rows.length - 1 && rows.length === visible.length;
		const [glyph, slot] = GLYPH[t.status as keyof typeof GLYPH];
		const subject = sanitize(t.subject);
		const body =
			t.status === "in_progress"
				? theme.fg("accent", subject)
				: t.status === "completed"
					? theme.fg("muted", theme.strikethrough ? theme.strikethrough(subject) : subject)
					: theme.fg("text", subject);
		let text = `${showIds ? theme.fg("dim", `#${t.id} `) : ""}${body}`;
		if (t.status === "in_progress" && t.activeForm) text += theme.fg("muted", ` (${sanitize(t.activeForm)})`);
		if (t.blockedBy?.length) text += theme.fg("muted", ` ⛓ ${t.blockedBy.map((b) => `#${b}`).join(",")}`);
		const prefix = `${theme.fg("dim", last ? "└─" : "├─")} ${theme.fg(slot, glyph)} `;
		if (width === undefined) {
			lines.push(prefix + text);
			return;
		}
		const indent = `${last ? " " : theme.fg("dim", "│")}    `;
		wrapTextWithAnsi(text, Math.max(1, width - 5)).forEach((part, j) => lines.push((j === 0 ? prefix : indent) + part));
	});
	if (rows.length < visible.length) {
		const rest = visible.filter((t) => !rows.includes(t));
		const c = rest.filter((t) => t.status === "completed").length;
		lines.push(theme.fg("dim", `└─ +${rest.length} more (${c} completed, ${rest.length - c} pending)`));
	}
	return lines;
}
