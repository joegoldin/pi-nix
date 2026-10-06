// Background shell tasks: bg_run, bg_status, bg_logs, bg_kill, and /jobs,
// /logs and /kill for the person at the keyboard.
//
// A task is a shell command in its own process group, its stdout and stderr
// appended to one file under .pi/tasks. When it ends, a
// <background-task-notification> message tells the model, by default starting
// a follow-up turn, so the model never has to poll. Everything is in memory
// for the life of the session; on shutdown running tasks are killed.
//
// Behaviour and wording follow pi-background-tasks run with
// PI_BG_FEATURES=process, the only part of it this setup used.

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync, type WriteStream } from "node:fs";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatLogs,
	formatNotification,
	formatSize,
	formatSnapshotList,
	formatStarted,
	nameFromCommand,
	resolveId,
	sanitizeSegment,
	statusLine,
	type TaskSnapshot,
	type TaskStatus,
} from "./bg-format.ts";

const MAX_LOG_BYTES = 50 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const KILL_GRACE_MS = 3000;
const STOP_WAIT_MS = 4500;
const MAX_RECENT_TASKS = 100;
const STATUS_KEY = "background-tasks";

type KillKind = "user" | "shutdown" | "timeout" | "output_cap";

interface Task extends TaskSnapshot {
	absOutputPath: string;
	notify: boolean;
	trigger: boolean;
	child?: ChildProcess;
	stream?: WriteStream;
	bytes: number;
	killKind?: KillKind;
	timer?: ReturnType<typeof setTimeout>;
	finishing?: boolean;
	done: Promise<void>;
	resolveDone: () => void;
}

function snapshot(t: Task): TaskSnapshot {
	const { id, name, command, description, status, pid, exitCode, signal, error, startTime, endTime, outputPath } = t;
	return { id, name, command, description, status, pid, exitCode, signal, error, startTime, endTime, outputPath };
}

/** The shell bg_run runs commands with: the user's, never as a login shell. */
function userShell(): string {
	return process.env.SHELL || "/bin/sh";
}

/** Returns how many tasks are running now, for the run summary. */
export function registerBackgroundTasks(pi: ExtensionAPI): { running(): number } {
	const tasks = new Map<string, Task>();
	const seen = new Set<string>();
	// Pinned to the first task's cwd for the session, so output stays in one
	// place even if the working directory changes.
	let runDir: string | undefined;
	let shuttingDown = false;
	let ctxRef: ExtensionContext | undefined;

	const list = () => [...tasks.values()];

	function refreshStatus(): void {
		try {
			ctxRef?.ui.setStatus(STATUS_KEY, statusLine(list().map(snapshot), seen));
		} catch {
			// A replaced session's context; the next one refreshes it.
		}
	}

	function directory(ctx: ExtensionContext): string {
		if (!runDir) {
			runDir = join(ctx.cwd, ".pi", "tasks", `${sanitizeSegment(ctx.sessionManager.getSessionId())}-${process.pid}`);
			mkdirSync(runDir, { recursive: true });
		}
		return runDir;
	}

	function prune(): void {
		const finished = list().filter((t) => t.status !== "running").sort((a, b) => a.startTime - b.startTime);
		while (tasks.size > MAX_RECENT_TASKS && finished.length) tasks.delete(finished.shift()!.id);
	}

	function signalGroup(t: Task, signal: NodeJS.Signals): void {
		if (!t.child?.pid) return;
		try {
			process.kill(-t.child.pid, signal);
		} catch {
			// Already gone, or never got its own group; try the child itself.
			try {
				t.child.kill(signal);
			} catch {}
		}
	}

	function kill(t: Task, kind: KillKind): void {
		if (t.status !== "running" || t.killKind) return;
		t.killKind = kind;
		signalGroup(t, "SIGTERM");
		setTimeout(() => {
			if (t.status === "running") signalGroup(t, "SIGKILL");
		}, KILL_GRACE_MS).unref();
	}

	function append(t: Task, chunk: Buffer | string): void {
		if (!t.stream || t.killKind === "output_cap") return;
		const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		const room = MAX_OUTPUT_BYTES - t.bytes;
		if (data.length > room) {
			t.stream.write(data.subarray(0, Math.max(0, room)));
			t.bytes = MAX_OUTPUT_BYTES;
			t.stream.write(`\n\n[background task error: Output exceeded cap of ${formatSize(MAX_OUTPUT_BYTES)}; terminating task]\n`);
			t.error = `Output exceeded cap of ${formatSize(MAX_OUTPUT_BYTES)}`;
			kill(t, "output_cap");
			return;
		}
		t.bytes += data.length;
		t.stream.write(data);
	}

	async function finish(t: Task, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		// A failed spawn can report both "error" and "close".
		if (t.finishing) return;
		t.finishing = true;
		if (t.timer) clearTimeout(t.timer);
		t.exitCode = code ?? undefined;
		t.signal = signal ?? undefined;
		if (t.killKind === "user" || t.killKind === "shutdown") t.status = "killed";
		else if (t.killKind === "timeout" || t.killKind === "output_cap") t.status = "failed";
		else if (code === 0 || (code === null && !signal && !t.error)) t.status = "completed";
		else {
			t.status = "failed";
			t.error ??= `Exited with code ${code ?? "?"}${signal ? ` (${signal})` : ""}`;
		}
		// Terminal state is only published once the output is on disk, so a
		// notification never points at a file still being written.
		await new Promise<void>((resolve) => (t.stream ? t.stream.end(resolve) : resolve()));
		t.endTime = Date.now();
		t.child = undefined;
		t.resolveDone();
		if (t.notify && !shuttingDown) {
			pi.sendMessage(
				{ customType: "background-task-notification", content: formatNotification(snapshot(t)), display: true, details: snapshot(t) },
				{ deliverAs: "followUp", triggerTurn: t.trigger },
			);
		}
		prune();
		refreshStatus();
	}

	function start(
		ctx: ExtensionContext,
		opts: { name: string; command: string; description?: string; timeoutSeconds?: number; notify: boolean; trigger: boolean },
	): Task {
		const command = opts.command.trim();
		if (!command) throw new Error("Background command is empty");
		const dir = directory(ctx);
		let id = "";
		do id = `b${randomBytes(4).toString("hex")}`;
		while (tasks.has(id));
		const absOutputPath = join(dir, `${id}.output`);
		let resolveDone = () => {};
		const t: Task = {
			id,
			name: opts.name,
			command,
			description: opts.description,
			status: "running",
			startTime: Date.now(),
			outputPath: relative(ctx.cwd, absOutputPath) || absOutputPath,
			absOutputPath,
			notify: opts.notify,
			trigger: opts.trigger,
			bytes: 0,
			done: new Promise<void>((r) => (resolveDone = r)),
			resolveDone: () => resolveDone(),
		};
		t.stream = createWriteStream(absOutputPath, { flags: "a" });
		t.stream.on("error", (err) => {
			t.error = `Output file write failed: ${err.message}`;
			kill(t, "output_cap");
		});
		const child = spawn(userShell(), ["-c", command], {
			cwd: ctx.cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		t.child = child;
		t.pid = child.pid;
		child.stdout?.on("data", (c) => append(t, c));
		child.stderr?.on("data", (c) => append(t, c));
		child.on("error", (err) => {
			append(t, `\n[background task spawn error: ${err.message}]\n`);
			t.error = err.message;
			if (!t.child?.pid) void finish(t, null, null);
		});
		child.on("close", (code, signal) => void finish(t, code, signal));
		const timeout = Math.floor(opts.timeoutSeconds ?? 0);
		if (timeout > 0) {
			t.timer = setTimeout(() => {
				append(t, `\n[background task timeout: Timed out after ${timeout}s]\n`);
				t.error = `Timed out after ${timeout}s`;
				kill(t, "timeout");
			}, timeout * 1000);
		}
		tasks.set(id, t);
		prune();
		refreshStatus();
		return t;
	}

	async function stop(t: Task, kind: KillKind): Promise<void> {
		if (t.status !== "running") throw new Error(`Task ${t.id} is ${t.status}, not running`);
		kill(t, kind);
		const timedOut = await Promise.race([t.done.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), STOP_WAIT_MS))]);
		if (timedOut) throw new Error(`Task ${t.id} did not exit within ${STOP_WAIT_MS / 1000}s after cancellation`);
	}

	function readLog(t: Task, maxBytes: number, tail: boolean): { text: string; total: number; read: number } {
		if (!existsSync(t.absOutputPath)) throw new Error(`Output file does not exist for ${t.id}: ${t.outputPath}`);
		const total = statSync(t.absOutputPath).size;
		const read = Math.min(total, maxBytes);
		const buffer = Buffer.alloc(read);
		const fd = openSync(t.absOutputPath, "r");
		try {
			readSync(fd, buffer, 0, read, tail ? total - read : 0);
		} finally {
			closeSync(fd);
		}
		return { text: buffer.toString("utf8"), total, read };
	}

	const clampBytes = (n: number | undefined) =>
		n === undefined || !Number.isFinite(n) ? MAX_LOG_BYTES : Math.min(MAX_LOG_BYTES, Math.max(1, Math.floor(n)));

	pi.registerTool({
		name: "bg_run",
		label: "Background Run",
		description: `Start a named long-running shell command in the background and return immediately with a task ID and output path. By default, completed, failed, or killed terminal state is delivered automatically as <background-task-notification> and starts a follow-up agent turn; do not sleep or poll merely to wait. Output is written to .pi/tasks and model-visible logs are bounded to ${formatSize(MAX_LOG_BYTES)}.`,
		promptSnippet: "Start a named long-running shell command; default terminal notification wakes a follow-up turn, so yield instead of polling",
		promptGuidelines: [
			"Use bg_run instead of bash for commands expected to run for a long time, such as test suites, dev servers, watchers, or builds.",
			"When using bg_run, always set name to a concise 2-6 word human-readable label for the footer task dock; do not use the raw command as the name unless it is already short and meaningful.",
			"bg_run returns immediately. With notifyOnCompletion:true and triggerOnCompletion:true (both defaults), completed, failed, or killed terminal state is delivered as <background-task-notification> and automatically starts a follow-up agent turn.",
			"After a default bg_run launch, continue only independent useful work that does not merely wait for the task; otherwise briefly acknowledge it if useful, then end the current turn. Do not call sleep, bg_status, or bg_logs merely to wait; the terminal notification will wake you.",
			"Treat <background-task-notification> as durable terminal truth. Do not call bg_status to reconfirm it; call bg_logs only when the task output is needed.",
			"Use bg_status/bg_logs only when the user explicitly requests an update, automatic notification or wake-up was deliberately disabled, there is concrete evidence the task is hung, or a terminal notification arrived and output details are needed.",
			"Do not set notifyOnCompletion:false or triggerOnCompletion:false unless intentionally opting out of automatic completion handling.",
			`bg_run runs commands with ${userShell()} -c, not as a login shell; write portable POSIX shell syntax and do not assume Bash-only features.`,
		],
		parameters: Type.Object({
			name: Type.String({
				description: "Short human-readable task name shown in the bg footer dock. Required; use 2-6 words, not the raw command.",
			}),
			command: Type.String({ description: "Shell command to start in the background" }),
			description: Type.Optional(Type.String({ description: "Optional longer human-readable context for the task" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Optional timeout; task is failed and killed when exceeded" })),
			notifyOnCompletion: Type.Optional(
				Type.Boolean({
					description:
						"Whether to deliver the durable terminal notification. Default: true; disable only when deliberately taking over completion monitoring.",
				}),
			),
			triggerOnCompletion: Type.Optional(
				Type.Boolean({
					description:
						"Whether that notification should automatically trigger a follow-up agent turn. Default: true for bg_run; requires notifyOnCompletion.",
				}),
			),
		}),
		prepareArguments(raw) {
			if (!raw || typeof raw !== "object") throw new Error("bg_run arguments must be an object");
			const args = raw as Record<string, unknown>;
			if (typeof args.command !== "string") throw new Error("bg_run requires command string");
			// A missing name costs the dock label, not the call.
			const name =
				(typeof args.name === "string" && args.name.trim()) ||
				(typeof args.description === "string" && args.description.trim()) ||
				nameFromCommand(args.command);
			return { ...args, name } as never;
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const notify = params.notifyOnCompletion ?? true;
			const trigger = params.triggerOnCompletion ?? true;
			const t = start(ctx, {
				name: params.name,
				command: params.command,
				description: params.description,
				timeoutSeconds: params.timeoutSeconds,
				notify,
				trigger,
			});
			return { content: [{ type: "text" as const, text: formatStarted(snapshot(t), notify, trigger) }], details: { task: snapshot(t) } };
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background Status",
		description:
			"Inspect one background task or list all running/recent background tasks. This is a point-in-time inspection tool, not a waiting primitive.",
		promptSnippet: "Inspect point-in-time status for one or all background tasks; never poll it as a wait loop",
		promptGuidelines: [
			"Use bg_status for deliberate point-in-time inspection, not as a waiting primitive.",
			"A running result is not an instruction to poll again. Do not repeatedly call bg_status while an automatic terminal notification is pending.",
			"Use bg_status when the user explicitly requests an update, automatic completion handling was disabled, or concrete evidence suggests a task is hung; terminal notifications do not need reconfirmation.",
		],
		parameters: Type.Object({
			taskId: Type.Optional(
				Type.String({ description: "Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned." }),
			),
		}),
		async execute(_id, params) {
			const chosen = params.taskId ? [resolveId(list(), params.taskId)] : list();
			const snaps = chosen.map(snapshot);
			return { content: [{ type: "text" as const, text: formatSnapshotList(snaps) }], details: { tasks: snaps } };
		},
	});

	pi.registerTool({
		name: "bg_logs",
		label: "Background Logs",
		description: `Read bounded output from a background task for deliberate inspection; this is not a waiting primitive. Output is capped at ${formatSize(MAX_LOG_BYTES)} for model safety and points to the full output file when truncated.`,
		promptSnippet: "Read bounded task output when needed; never tail it repeatedly as a wait loop",
		promptGuidelines: [
			"Use bg_logs with a modest maxBytes value only when task output is needed, without flooding context.",
			"Do not repeatedly call bg_logs to wait for completion while an automatic terminal notification is pending.",
			"Use bg_status first only when a deliberate inspection requires the current task state; do not reconfirm a terminal notification.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID or unambiguous prefix" }),
			maxBytes: Type.Optional(
				Type.Number({ description: `Maximum bytes to return, capped at ${formatSize(MAX_LOG_BYTES)}. Default: ${formatSize(MAX_LOG_BYTES)}.` }),
			),
			tail: Type.Optional(Type.Boolean({ description: "Read the tail of the log when true, head when false. Default: true." })),
		}),
		async execute(_id, params) {
			const t = resolveId(list(), params.taskId);
			const tail = params.tail ?? true;
			const { text, total, read } = readLog(t, clampBytes(params.maxBytes), tail);
			return {
				content: [{ type: "text" as const, text: formatLogs(text, total, read, tail, t.outputPath) }],
				details: { task: snapshot(t), path: t.outputPath, bytesRead: read, truncated: read < total, tail },
			};
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Background Kill",
		description: "Stop a running background task by ID. Fails loudly if the task is unknown or already finished.",
		promptSnippet: "Stop a running background task by ID",
		promptGuidelines: ["Use bg_kill when the user asks to stop a background task or when a bg_run command is no longer needed."],
		parameters: Type.Object({ taskId: Type.String({ description: "Task ID or unambiguous prefix to stop" }) }),
		async execute(_id, params) {
			const t = resolveId(list(), params.taskId);
			await stop(t, "user");
			const message = `Killed background task ${t.name} (${t.id}). Output: ${t.outputPath}`;
			return { content: [{ type: "text" as const, text: message }], details: { task: snapshot(t), message } };
		},
	});

	pi.registerMessageRenderer("background-task-notification", (message, _options, theme) => {
		const t = message.details as TaskSnapshot | undefined;
		const colour: Record<TaskStatus, string> = { completed: "success", failed: "error", killed: "warning", running: "muted" };
		const lines = t
			? [
					theme.fg(colour[t.status] as never, `[bg ${t.status}] `) + `${t.name} (${t.id})`,
					theme.fg("dim", `Output: ${t.outputPath}`),
					...(t.error ? [theme.fg("error", t.error)] : []),
				]
			: [String(message.content)];
		return { render: () => lines, invalidate() {} };
	});

	pi.registerCommand("jobs", {
		description: "List background tasks",
		handler: async (_args, ctx) => {
			for (const t of list()) seen.add(t.id);
			refreshStatus();
			ctx.ui.notify(formatSnapshotList(list().map(snapshot)), "info");
		},
	});

	pi.registerCommand("logs", {
		description: "Show the tail of a background task's output: /logs <id> [maxBytes]",
		getArgumentCompletions: (prefix) => list().filter((t) => t.id.startsWith(prefix)).map((t) => ({ value: t.id, label: t.id, description: t.name })),
		handler: async (args, ctx) => {
			const [id = "", bytes] = args.trim().split(/\s+/);
			try {
				const t = resolveId(list(), id);
				const { text, total, read } = readLog(t, clampBytes(bytes ? Number(bytes) : undefined), true);
				ctx.ui.notify(formatLogs(text, total, read, true, t.outputPath), "info");
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error");
			}
		},
	});

	pi.registerCommand("kill", {
		description: "Stop a running background task: /kill <id>",
		getArgumentCompletions: (prefix) =>
			list()
				.filter((t) => t.status === "running" && t.id.startsWith(prefix))
				.map((t) => ({ value: t.id, label: t.id, description: t.name })),
		handler: async (args, ctx) => {
			try {
				const t = resolveId(list(), args);
				await stop(t, "user");
				ctx.ui.notify(`Killed ${t.name} (${t.id})`, "info");
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		shuttingDown = false;
		refreshStatus();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		const running = list().filter((t) => t.status === "running");
		for (const t of running) {
			t.error = "Killed during Pi session shutdown";
			kill(t, "shutdown");
		}
		await Promise.race([Promise.all(running.map((t) => t.done)), new Promise((r) => setTimeout(r, STOP_WAIT_MS))]);
		runDir = undefined;
		ctxRef = undefined;
	});

	return { running: () => list().filter((t) => t.status === "running").length };
}
