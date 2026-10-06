// Text the background-task tools hand the model, kept apart from the process
// handling so every format is testable without spawning anything.
//
// The formats are pi-background-tasks' own, word for word: sessions recorded
// with that extension, and the habits the model formed reading its output,
// keep meaning the same thing.

export type TaskStatus = "running" | "completed" | "failed" | "killed";

export interface TaskSnapshot {
	id: string;
	name: string;
	command: string;
	description?: string;
	status: TaskStatus;
	pid?: number;
	exitCode?: number;
	signal?: string;
	error?: string;
	startTime: number;
	endTime?: number;
	/** Relative to the session's working directory, as the model is shown it. */
	outputPath: string;
}

const ICON: Record<TaskStatus, string> = { running: "▶", completed: "✓", killed: "■", failed: "✗" };

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatSnapshotList(tasks: TaskSnapshot[], now = Date.now()): string {
	if (tasks.length === 0) return "No background tasks in this Pi extension runtime.";
	return tasks
		.map((t) => {
			const parts = [`${ICON[t.status]} ${t.id} ${t.status} ${formatDuration((t.endTime ?? now) - t.startTime)}`];
			if (t.exitCode !== undefined) parts.push(`exit=${t.exitCode}`);
			if (t.pid !== undefined) parts.push(`pid=${t.pid}`);
			let line = `${parts.join(" ")} — ${clip(t.name, 90)}`;
			if (t.error) line += ` error=${clip(t.error, 80)}`;
			return `${line}\n    output: ${t.outputPath}`;
		})
		.join("\n");
}

/** What bg_run tells the model about how it will hear the task finished. */
export function completionGuidance(notify: boolean, trigger: boolean): string {
	if (notify && trigger) {
		return [
			"Terminal notification: enabled.",
			"Automatic follow-up turn: enabled.",
			"Next action: do not poll or sleep merely to wait; continue only independent useful work, otherwise end this turn and wait for <background-task-notification>.",
		].join("\n");
	}
	if (notify) {
		return [
			"Terminal notification: enabled.",
			"Automatic follow-up turn: disabled. The terminal notification will be delivered, but it will not start an agent turn.",
			"Next action: automatic wake-up was explicitly disabled; use bg_status/bg_logs only when deliberate monitoring is required, without tight polling.",
		].join("\n");
	}
	return [
		"Terminal notification: disabled.",
		trigger
			? "Automatic follow-up turn: disabled because terminal notifications are disabled. triggerOnCompletion has no effect while notifyOnCompletion is false."
			: "Automatic follow-up turn: disabled.",
		"Next action: completion delivery was explicitly disabled; use bg_status/bg_logs only for deliberate manual monitoring, without tight polling.",
	].join("\n");
}

export function formatStarted(t: TaskSnapshot, notify: boolean, trigger: boolean): string {
	return [
		`Started background task ${t.name} (${t.id})`,
		"Status: running",
		`PID: ${t.pid ?? "unknown"}`,
		`Output: ${t.outputPath}`,
		completionGuidance(notify, trigger),
	].join("\n");
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * bg_logs' text: the bounded read and where the rest is. For a tail read the
 * notice comes first, because the reader starts at the top and the top is
 * where the gap is.
 */
export function formatLogs(text: string, total: number, read: number, tail: boolean, outputPath: string): string {
	const body = text === "" ? "(no output yet)" : text;
	if (read >= total) return `${body}\n\n[Full output: ${outputPath}]`;
	const notice = `[Showing ${tail ? "tail" : "head"} ${formatSize(read)} of ${formatSize(total)}; ${formatSize(total - read)} omitted. Full output: ${outputPath}]`;
	return tail ? `${notice}\n\n${body}` : `${body}\n\n${notice}`;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The message that wakes the model when a task ends. */
export function formatNotification(t: TaskSnapshot): string {
	return [
		"<background-task-notification>",
		`  <task-id>${t.id}</task-id>`,
		`  <task-name>${escapeXml(t.name)}</task-name>`,
		`  <status>${t.status}</status>`,
		t.exitCode !== undefined ? `  <exit-code>${t.exitCode}</exit-code>` : "",
		t.error ? `  <error>${escapeXml(t.error)}</error>` : "",
		`  <output-file>${t.outputPath}</output-file>`,
		`  <summary>Background task "${escapeXml(t.name)}" ${t.status}</summary>`,
		"  <guidance>Terminal state and output metadata are durable. Do not call bg_status to reconfirm; use bg_logs only if output is needed.</guidance>",
		"</background-task-notification>",
	]
		.filter((line) => line !== "")
		.join("\n");
}

/** A dock name from the command when the model gave none: its first words, briefly. */
export function nameFromCommand(command: string): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return clip(flat, 60) || "background task";
}

/** Directory-safe form of a session id. */
export function sanitizeSegment(text: string): string {
	return text.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

/** Exact id or a unique prefix, with pi-background-tasks' error wording. */
export function resolveId<T extends { id: string }>(tasks: T[], raw: string): T {
	const id = raw.trim();
	if (!id) throw new Error("Task ID is required");
	const exact = tasks.find((t) => t.id === id);
	if (exact) return exact;
	const matches = tasks.filter((t) => t.id.startsWith(id));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`Ambiguous task ID prefix "${id}": ${matches.map((t) => t.id).join(", ")}`);
	throw new Error(`Unknown background task ID: ${id}`);
}

/** The one-line footer summary, or undefined when there is nothing to say. */
export function statusLine(tasks: TaskSnapshot[], seen: Set<string>): string | undefined {
	const running = tasks.filter((t) => t.status === "running").length;
	const unseen = tasks.filter((t) => t.status !== "running" && !seen.has(t.id));
	const failed = unseen.filter((t) => t.status === "failed").length;
	const killed = unseen.filter((t) => t.status === "killed").length;
	const done = unseen.filter((t) => t.status === "completed").length;
	const parts = [
		running ? `${running} running` : "",
		failed ? `${failed} failed` : "",
		killed ? `${killed} stopped` : "",
		done ? `${done} done` : "",
	].filter(Boolean);
	return parts.length ? `bg ${parts.join(" · ")}` : undefined;
}
