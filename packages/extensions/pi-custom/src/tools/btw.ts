// Native side sessions remain independent of the main transcript. Bringing back
// an exchange only drafts a main-conversation message; it never submits one.
import { createHash, randomUUID } from "node:crypto";
import { Framed } from "../ui/frame.ts";
import { activityKey, reportActivity, type ActivityStatus } from "../program-status.ts";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	SessionManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	BtwView,
	bringBackDraft,
	bringBackThreadDraft,
	type Thread,
	type Turn,
} from "./btw-view.ts";
import {
	createSideRuntime,
	disposeSideRuntime,
	type SideMode,
} from "./btw-runtime.ts";
import { registerSideConversations } from "./btw-fleet.ts";
import { forkSideSession } from "./btw-session.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
export { BtwView, bringBackDraft, bringBackThreadDraft } from "./btw-view.ts";

const ENTRY = "pi-custom:btw-session";
interface SavedThread {
	version: 1;
	id: string;
	sessionId: string;
	file: string;
	baseline: string | null;
	name: string;
	mode: SideMode;
	draft: string;
	updatedAt: number;
	parentId?: string;
}
interface LiveThread extends Thread {
	status?: ActivityStatus;
	childStatuses?: Map<string, ActivityStatus>;
	saved: SavedThread;
	manager: SessionManager;
	runtime?: AgentSession;
	render?: () => void;
	unsubscribe?: () => void;
}

type SideMessage = ReturnType<
	SessionManager["buildSessionContext"]
>["messages"][number];
export function sideTurns(
	manager: SessionManager,
	baseline: string | null,
	partial?: SideMessage,
): Turn[] {
	const branch = manager.getBranch();
	const start = baseline
		? branch.findIndex((entry) => entry.id === baseline) + 1
		: 0;
	const messages = branch
		.slice(start)
		.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	if (partial) messages.push(partial);
	const turns: Turn[] = [];
	for (const message of messages) {
		if (
			message.role !== "user" &&
			message.role !== "assistant" &&
			message.role !== "toolResult"
		)
			continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		if (message.role === "user") turns.push({ question: text });
		else if (turns.length && message.role === "assistant") {
			const turn = turns.at(-1)!;
			if (text) turn.answer = [turn.answer, text].filter(Boolean).join("\n\n");
			if (message.stopReason === "error")
				turn.error =
					message.errorMessage ?? "The side model returned an error.";
		} else if (turns.length && message.role === "toolResult") {
			const turn = turns.at(-1)!;
			turn.answer = [
				turn.answer,
				`Tool ${message.toolName}: ${message.isError ? "failed" : "returned"}.\n${text}`,
			]
				.filter(Boolean)
				.join("\n\n");
		}
	}
	return turns;
}

export function registerBtw(
	pi: ExtensionAPI,
	createRuntime = createSideRuntime,
): void {
	const threads = new Map<string, LiveThread>();
	let shuttingDown = false;
	const fleetBindings = new Map<string, () => void>();
	const directory = (ctx: ExtensionContext) => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file)
			throw new Error("Side conversations require a disk-backed main session.");
		return join(
			dirname(file),
			"btw",
			createHash("sha256")
				.update(ctx.sessionManager.getSessionId())
				.digest("hex"),
		);
	};
	const save = (thread: LiveThread) => {
		thread.saved.draft = thread.draft ?? "";
		thread.saved.updatedAt = Date.now();
		const temporary = `${thread.saved.file}.btw-${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(thread.saved), {
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, `${thread.saved.file}.btw.json`);
	};
	const live = (saved: SavedThread, manager: SessionManager): LiveThread => ({
		id: saved.id,
		sessionId: saved.sessionId,
		draft: saved.draft,
		turns: sideTurns(manager, saved.baseline),
		saved,
		manager,
	});
	function restore(ctx: ExtensionContext): void {
		const owner = ctx.sessionManager.getSessionId();
		const root = directory(ctx);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			const ref = entry.data as SavedThread;
			if (
				!ref ||
				ref.sessionId !== owner ||
				typeof ref.file !== "string" ||
				resolve(dirname(ref.file)) !== resolve(root) ||
				threads.has(ref.id)
			)
				continue;
			try {
				const saved = JSON.parse(
					readFileSync(`${ref.file}.btw.json`, "utf8"),
				) as SavedThread;
				if (
					saved.version !== 1 ||
					saved.id !== ref.id ||
					saved.sessionId !== owner ||
					saved.file !== ref.file ||
					!["read-only", "edit"].includes(saved.mode) ||
					typeof saved.draft !== "string"
				)
					throw new Error("Invalid saved side conversation");
				if (!existsSync(saved.file))
					throw new Error("Side-conversation session file is missing");
				const manager = SessionManager.open(saved.file);
				if (manager.getSessionId() !== saved.id)
					throw new Error("Side-conversation session identity changed");
				threads.set(saved.id, live(saved, manager));
			} catch (error) {
				ctx.ui.notify(
					`Cannot resume /btw: ${(error as Error).message}`,
					"error",
				);
			}
		}
	}
	function fresh(
		ctx: ExtensionContext,
		blank = false,
		source?: LiveThread,
	): LiveThread {
		const root = directory(ctx);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const manager = blank
			? SessionManager.create(ctx.cwd, root)
			: forkSideSession(source?.manager ?? ctx.sessionManager, ctx.cwd, root);
		const file = manager.getSessionFile()!;
		// Pi delays an empty session's first write until a message. Persist its
		// native header/entries now so an unsent draft can survive a restart too.
		if (!existsSync(file))
			writeFileSync(
				file,
				[manager.getHeader(), ...manager.getEntries()]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
				{ flag: "wx", mode: 0o600 },
			);
		const saved: SavedThread = {
			version: 1,
			id: manager.getSessionId(),
			sessionId: ctx.sessionManager.getSessionId(),
			file,
			baseline: source ? source.saved.baseline : manager.getLeafId(),
			name: source ? `Fork of ${source.saved.name}` : "Side conversation",
			mode: "read-only",
			draft: "",
			updatedAt: Date.now(),
			...(source ? { parentId: source.id } : {}),
		};
		const thread = live(saved, manager);
		save(thread);
		pi.appendEntry(ENTRY, saved);
		threads.set(thread.id, thread);
		return thread;
	}
	function reportThread(ctx: ExtensionContext, thread: LiveThread, status: ActivityStatus): void {
		thread.status = { ...status, title: "Side conversation" };
		reportActivity(ctx, activityKey("btw", thread.id), thread.status);
	}

	async function runtime(
		ctx: ExtensionContext,
		thread: LiveThread,
	): Promise<AgentSession> {
		if (thread.runtime) return thread.runtime;
		// Child dialogs use the native focus stack, but child status/editor writes
		// must never overwrite the main prompt, footer, or widgets.
		const ui = {
			...ctx.ui,
			setStatus() {},
			setProgramStatus(key: string, status: ActivityStatus | undefined) {
				const statuses = thread.childStatuses ??= new Map();
				if (status) statuses.set(key, status);
				else for (const saved of statuses.keys()) if (saved === key || saved.startsWith(`${key}/`)) statuses.delete(saved);
				reportActivity(ctx, `${activityKey("btw", thread.id)}/${key}`, status);
			},
			setWidget() {},
			setFooter() {},
			setHeader() {},
			setWorkingMessage() {},
			setEditorText(text: string) {
				thread.draft = text;
			},
			getEditorText: () => thread.draft ?? "",
		} as ExtensionUIContext;
		const created = await createRuntime(
			pi,
			ctx,
			thread.manager,
			thread.saved.mode,
			ui,
		);
		if (shuttingDown) {
			await disposeSideRuntime(created);
			throw new Error(
				"The main session shut down before this side conversation started.",
			);
		}
		thread.runtime = created;
		thread.unsubscribe = thread.runtime.subscribe((event) => {
			const refresh = () => {
				thread.turns = sideTurns(
					thread.manager,
					thread.saved.baseline,
					event.type === "message_update" ? event.message : undefined,
				);
				thread.render?.();
			};
			// Public message_end listeners run before native session persistence.
			if (event.type === "message_end") queueMicrotask(refresh);
			else refresh();
		});
		return thread.runtime;
	}
	async function answer(
		ctx: ExtensionContext,
		thread: LiveThread,
		question: string,
		signal: AbortSignal,
	): Promise<void> {
		thread.saved.name =
			thread.saved.name === "Side conversation"
				? question.slice(0, 70)
				: thread.saved.name;
		reportThread(ctx, thread, { state: "working", message: "Side conversation running" });
		let session: AgentSession | undefined;
		const abort = () => {
			void session?.abort();
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			session = await runtime(ctx, thread);
			if (!signal.aborted) await session.prompt(question);
			thread.turns = sideTurns(thread.manager, thread.saved.baseline);
		} catch (error) {
			thread.turns = sideTurns(thread.manager, thread.saved.baseline);
			if (thread.turns.at(-1)?.question !== question)
				thread.turns.push({ question });
			thread.turns.at(-1)!.error = (error as Error).message;
		} finally {
			reportThread(ctx, thread, { state: signal.aborted ? "idle" : thread.turns.at(-1)?.error ? "error" : "done", message: signal.aborted ? "Side conversation cancelled" : thread.turns.at(-1)?.error ? "Side conversation failed" : "Side conversation finished" });
			signal.removeEventListener("abort", abort);
			try {
				save(thread);
			} catch (error) {
				ctx.ui.notify(`Cannot save /btw: ${(error as Error).message}`, "error");
			}
		}
	}
	async function choose(
		ctx: ExtensionContext,
	): Promise<LiveThread | undefined> {
		restore(ctx);
		const items = [...threads.values()]
			.filter(
				(thread) => thread.sessionId === ctx.sessionManager.getSessionId(),
			)
			.sort((a, b) => b.saved.updatedAt - a.saved.updatedAt);
		const labels = [
			"Fork main conversation",
			"New blank conversation",
			...items.map(
				(thread) =>
					`${thread.busy ? "Running" : "Resume"}: ${thread.saved.name} [${thread.id.slice(0, 8)}]`,
			),
		];
		const picked = await ctx.ui.select("Side conversations", labels);
		if (!picked) return;
		const index = labels.indexOf(picked);
		return index === 0
			? fresh(ctx)
			: index === 1
				? fresh(ctx, true)
				: items[index - 2];
	}
	async function open(
		ctx: ExtensionContext,
		initial: LiveThread,
		question?: string,
	): Promise<void> {
		let thread: LiveThread | undefined = initial;
		while (thread) {
			const current = thread;
			let draft: string | undefined;
			const action = await ctx.ui.custom<
				"close" | "fork" | "fresh" | "switch" | "mode"
			>(
				(tui, theme, _keys, done) => {
					current.render = () => tui.requestRender();
					const view = new BtwView(
						current,
						theme,
						(q, signal) => answer(ctx, current, q, signal),
						(all) => {
							const last = [...current.turns]
								.reverse()
								.find((turn) => turn.answer);
							if (!all && !last) return;
							draft = all
								? bringBackThreadDraft(current.turns)
								: bringBackDraft(last!);
							done("close");
						},
						() => done("close"),
						current.render,
						() => Math.max(5, Math.floor(tui.terminal.rows * 0.8) - 3),
						{
							fork: () => done("fork"),
							fresh: () => done("fresh"),
							switch: () => done("switch"),
							mode: () => {
								if (!current.busy) done("mode");
								else
									ctx.ui.notify(
										"Stop or finish the current turn before changing tool mode.",
										"info",
									);
							},
							stop: () => current.busy?.abort(),
						},
					);
					if (question) {
						view.start(question);
						question = undefined;
					}
					return {
						render: (width) => new Framed(
							view,
							truncateToWidth(`btw · ${current.saved.mode} · ${current.saved.name.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ")}`, Math.max(1, width - 5)),
							theme,
						).render(width),
						invalidate: () => view.invalidate(),
						handleInput: (data) => {
							view.handleInput(data);
							tui.requestRender();
						},
						handleMouse: (event) => view.handleMouse(event),
					};
				},
				{
					overlay: true,
					overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
				},
			);
			current.render = undefined;
			save(current);
			if (draft) {
				const previous = ctx.ui.getEditorText();
				ctx.ui.setEditorText(
					previous.trim() ? `${previous}\n\n${draft}` : draft,
				);
			}
			if (action === "fork") thread = fresh(ctx, false, current);
			else if (action === "fresh") thread = fresh(ctx, true);
			else if (action === "switch") thread = await choose(ctx);
			else if (action === "mode") {
				const selected = await ctx.ui.select("Side-conversation tools", [
					"Read-only",
					"Editing (permission gates still apply)",
				]);
				if (selected) {
					if (current.runtime) {
						current.unsubscribe?.();
						await disposeSideRuntime(current.runtime);
						current.runtime = undefined;
					}
					current.saved.mode = selected === "Read-only" ? "read-only" : "edit";
					save(current);
				}
			} else thread = undefined;
		}
	}
	function installFleet(ctx: ExtensionContext): void {
		const owner = ctx.sessionManager.getSessionId();
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		fleetBindings.get(file)?.();
		fleetBindings.set(
			file,
			registerSideConversations(file, {
				snapshot: () => {
					if (ctx.sessionManager.getSessionId() !== owner) return [];
					return [...threads.values()]
						.filter((thread) => thread.sessionId === owner)
						.map((thread) => ({
							id: thread.id,
							label: thread.saved.name,
							state: thread.busy ? "running" : "idle",
							startedAt: thread.saved.updatedAt,
							updatedAt: thread.saved.updatedAt,
							...(thread.saved.parentId
								? { parentId: thread.saved.parentId }
								: {}),
						}));
				},
				open: async (id) => {
					const thread = threads.get(id);
					if (
						!thread ||
						thread.sessionId !== owner ||
						ctx.sessionManager.getSessionId() !== owner
					)
						return;
					try {
						await open(ctx, thread);
					} catch (error) {
						ctx.ui.notify(
							`Cannot open /btw: ${(error as Error).message}`,
							"error",
						);
					}
				},
			}),
		);
	}
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		for (const thread of threads.values()) {
			if (thread.status) reportThread(ctx, thread, thread.status);
			for (const [key, status] of thread.childStatuses ?? []) reportActivity(ctx, `${activityKey("btw", thread.id)}/${key}`, status);
		}
		try {
			restore(ctx);
			installFleet(ctx);
		} catch (error) {
			ctx.ui.notify(
				`Cannot restore /btw: ${(error as Error).message}`,
				"error",
			);
		}
	});
	pi.registerCommand("btw", {
		description:
			"Independent side conversation; list, new, or a question to fork main",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive TUI mode", "error");
				return;
			}
			try {
				restore(ctx);
				installFleet(ctx);
				const question = args.trim();
				const thread =
					question === "new"
						? fresh(ctx, true)
						: !question || question === "list"
							? await choose(ctx)
							: fresh(ctx);
				if (thread)
					await open(
						ctx,
						thread,
						question && !["new", "list"].includes(question)
							? question
							: undefined,
					);
			} catch (error) {
				ctx.ui.notify(`Cannot open /btw: ${(error as Error).message}`, "error");
			}
		},
	});
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const dispose of fleetBindings.values()) dispose();
		fleetBindings.clear();
		const errors: unknown[] = [];
		for (const thread of threads.values()) {
			thread.busy?.abort();
			thread.unsubscribe?.();
			try {
				save(thread);
			} catch (error) {
				errors.push(error);
			}
			try {
				if (thread.runtime) await disposeSideRuntime(thread.runtime);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length)
			throw new AggregateError(
				errors,
				"Could not completely close side conversations",
			);
	});
}
