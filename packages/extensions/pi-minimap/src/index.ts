import { showHistory } from "./history.ts";
import { randomUUID } from "node:crypto";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	MinimapEngine,
	SYSTEM_PROMPT,
	type Completion,
	type ReportedUsage,
} from "./engine.ts";
import {
	clean,
	readBatch,
	record,
	restore,
	restoreUsage,
	STATE_TYPE,
	type ModelChoice,
} from "./state.ts";
import { MinimapView } from "./view.ts";
import { CerebrasRates, costAtRates } from "./pricing.ts";
import {
	createAuditWriter,
	type AuditInput,
	type AuditWriter,
} from "./audit.ts";

interface SidebarUI {
	setSidebar?(
		key: string,
		factory: ((tui: TUI, theme: Theme) => Component) | undefined,
		options?: {
			width?: number;
			onVisibilityChange?: (visible: boolean) => void;
		},
	): boolean;
	scrollToSessionEntry?(id: string): boolean;
	onEditorInput?(
		handler: (data: string) => { consume?: boolean } | undefined,
	): () => void;
}

/** Never interpret legacy CR (Enter) as Ctrl+M. Require an unambiguous encoding. */
export function shortcut(
	data: string,
): "toggle" | "model" | "consume" | undefined {
	if (data === "\x1bm") return "toggle";
	if (data === "\x1bM") return "model";
	const key = /^\x1b\[(109|77)(?::\d*){0,2};(\d+)(?::([123]))?u$/.exec(data);
	if (!key) return;
	const modifiers = (Number(key[2]) - 1) & ~(64 | 128);
	if (![2, 3, 4, 5].includes(modifiers)) return;
	if (key[3] === "2" || key[3] === "3") return "consume";
	return modifiers & 1 || key[1] === "77" ? "model" : "toggle";
}

export function reportedUsage(
	value: unknown,
	priced: boolean,
): ReportedUsage | undefined {
	if (!record(value)) return;
	const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
	if (
		!fields.every(
			(key) =>
				typeof value[key] === "number" &&
				Number.isFinite(value[key]) &&
				Number(value[key]) >= 0,
		)
	)
		return;
	// Every request has a nonempty prompt; the SDK's all-zero default is not a usage receipt.
	if (fields.every((key) => value[key] === 0)) return;
	const cost =
		record(value.cost) &&
		typeof value.cost.total === "number" &&
		Number.isFinite(value.cost.total) &&
		value.cost.total >= 0 &&
		(priced || value.cost.total > 0)
			? value.cost.total
			: undefined;
	return {
		input: Number(value.input),
		output: Number(value.output),
		cacheRead: Number(value.cacheRead),
		cacheWrite: Number(value.cacheWrite),
		cost,
	};
}

export default function register(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let engine: MinimapEngine | undefined;
	let view: MinimapView | undefined;
	let inFlight: Promise<Completion> | undefined;
	const rates = new CerebrasRates();
	let sessionId: string | undefined;
	let unsubscribe: (() => void) | undefined;
	let ageTimer: ReturnType<typeof setInterval> | undefined;
	const stopAgeTimer = () => {
		if (ageTimer) clearInterval(ageTimer);
		ageTimer = undefined;
	};
	let streaming: boolean | undefined;
	let idleStatus = "Idle";
	const waits = new Map<string, string>();
	const tools = new Map<string, string>();
	let order = new Map<string, number>();
	const setting = (
		name: string,
		fallback: number,
		min: number,
		max: number,
	) => {
		const value = Number(process.env[name]);
		return Number.isFinite(value) && value >= min
			? Math.min(max, Math.floor(value))
			: fallback;
	};
	const status = () => {
		const names = [...tools.values()];
		if (
			names.some(
				(name) => name === "ask_user_question" || name === "contact_supervisor",
			)
		)
			return "Waiting for an answer";
		if (names.length)
			return `Running ${clean(names[0]!, 25)}${names.length > 1 ? ` +${names.length - 1}` : ""}`;
		if (streaming === true) return "Agent working";
		if (streaming === false) return idleStatus;
		return ctx?.isIdle() ? idleStatus : "Agent active";
	};
	const changed = () => {
		view?.refresh();
	};

	async function request(
		owner: ExtensionContext,
		choice: ModelChoice,
		prompt: string,
		signal: AbortSignal,
		started: () => void,
		audit: AuditWriter,
	): Promise<Completion> {
		if (inFlight) await inFlight.catch(() => {});
		if (signal.aborted) throw new Error("Cancelled");
		const available = owner.modelRegistry.getAvailable();
		const model =
			choice === "qwen"
				? available.find(
						(model) =>
							model.provider === "cerebras" &&
							(process.env.PI_MINIMAP_QWEN_MODEL
								? model.id === process.env.PI_MINIMAP_QWEN_MODEL
								: /qwen/i.test(model.id)),
					)
				: available.find(
						(model) =>
							model.provider ===
								(process.env.PI_MINIMAP_LUNA_PROVIDER || "openai") &&
							model.id === (process.env.PI_MINIMAP_LUNA_MODEL || "gpt-6-luna"),
					);
		const callId = randomUUID();
		const sessionId = owner.sessionManager.getSessionId();
		const parameters = {
			maxTokens: 600,
			sessionId: `pi-minimap:${sessionId}:${choice}`,
			...(choice === "luna" ? { reasoning: "low" as const } : {}),
		};
		audit({
			id: callId,
			phase: "request",
			at: Date.now(),
			model: model ? `${model.provider}/${model.id}` : choice,
			prompt,
			systemPrompt: SYSTEM_PROMPT,
			parameters,
			sourceId: owner.sessionManager.getLeafId?.(),
		});
		const pending = (async (): Promise<Completion> => {
			try {
				if (!model) throw new Error("Selected model unavailable");
				const prices = await rates.get(
					model,
					async () => {
						const auth = await owner.modelRegistry.getApiKeyAndHeaders(model);
						if (
							!auth.ok ||
							(auth.baseUrl &&
								auth.baseUrl.replace(/\/$/, "") !==
									"https://api.cerebras.ai/v1")
						)
							return;
						return auth.apiKey;
					},
					signal,
				);
				if (signal.aborted) throw new Error("Cancelled");
				audit({ id: callId, phase: "started", at: Date.now() });
				started();
				const response = await owner.modelRegistry
					.streamSimple(
						model,
						{
							systemPrompt: SYSTEM_PROMPT,
							messages: [
								{ role: "user", content: prompt, timestamp: Date.now() },
							],
						},
						{ signal, ...parameters },
					)
					.result();
				const priced = Object.values(model.cost).some(
					(value) => typeof value === "number" && value > 0,
				);
				const usage = reportedUsage(response.usage, priced);
				if (usage && prices) usage.cost = costAtRates(usage, prices);
				const text = response.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				audit({
					id: callId,
					phase: "response",
					at: Date.now(),
					text,
					stopReason: response.stopReason,
					reportedUsage: usage,
					pricing: { perToken: prices, configuredPerMillion: model.cost },
				});
				return {
					callId,
					text,
					usage,
					error: ["error", "aborted", "length"].includes(response.stopReason)
						? "Incomplete summary"
						: undefined,
				};
			} catch (error) {
				audit({
					id: callId,
					phase: "error",
					at: Date.now(),
					error: signal.aborted
						? "Cancelled"
						: !model
							? "Selected model unavailable"
							: "Summary request failed",
				});
				throw error;
			}
		})();
		inFlight = pending;
		try {
			return await pending;
		} finally {
			if (inFlight === pending) inFlight = undefined;
		}
	}

	function mount(): void {
		stopAgeTimer();
		if (!ctx || !engine) return;
		const owner = ctx,
			current = engine,
			ui = owner.ui as ExtensionContext["ui"] & SidebarUI;
		if (!current.state.enabled) {
			current.setVisible(false);
			ui.setSidebar?.("pi-minimap", undefined);
			view = undefined;
			return;
		}
		const accepted = ui.setSidebar?.(
			"pi-minimap",
			(tui, theme) => {
				view = new MinimapView(current, theme, {
					switchModel: () => current.switchModel(),
					jump: (id) => {
						if (!ui.scrollToSessionEntry?.(id))
							owner.ui.notify(
								"That source is no longer rendered (it may have been compacted).",
								"info",
							);
					},
					status,
					contains: (beat, id) =>
						order.has(id) &&
						(order.get(beat.from) ?? Infinity) <= order.get(id)! &&
						(order.get(beat.to) ?? -1) >= order.get(id)!,
					render: () => tui.requestRender(),
					rows: () => tui.terminal.rows,
				});
				return view;
			},
			{
				width: setting("PI_MINIMAP_WIDTH", 44, 24, 60),
				onVisibilityChange: (shown) => {
					if (current !== engine) return;
					stopAgeTimer();
					current.setVisible(shown && current.state.enabled);
					if (current.visible) {
						ageTimer = setInterval(() => view?.refresh(), 60_000);
						ageTimer.unref?.();
					}
				},
			},
		);
		if (!accepted) {
			current.state.enabled = false;
			current.setVisible(false);
			owner.ui.notify(
				"Minimap needs the native sidebar hook and fullscreen mode; another extension may also own the sidebar.",
				"warning",
			);
		}
	}

	function toggle(): void {
		if (!engine) return;
		engine.state.enabled = !engine.state.enabled;
		mount();
		engine.persist();
	}
	function load(_event: unknown, context: ExtensionContext): void {
		const id = context.sessionManager.getSessionId();
		// SessionManager is reused and mutates its ID on new/fork/resume.
		const usage = sessionId === id ? engine?.state.usage : undefined;
		sessionId = id;
		engine?.dispose();
		unsubscribe?.();
		ctx = context;
		view = undefined;
		streaming = undefined;
		idleStatus = "Idle";
		tools.clear();
		waits.clear();
		const branch = context.sessionManager.getBranch();
		order = new Map(branch.map((entry, index) => [entry.id, index]));
		const state = restore(branch);
		// History is branch-local; actual spend must not disappear when changing branches.
		state.usage =
			usage ?? restoreUsage(context.sessionManager.getEntries(), id);
		const writeAudit = createAuditWriter(
			context.sessionManager,
			() => ctx?.sessionManager,
			(type, data) => pi.appendEntry(type, data),
		);
		const audit: AuditWriter = (event) => {
			try {
				writeAudit(event);
			} catch (error) {
				context.ui.notify("Minimap history could not be saved", "error");
				throw error;
			}
		};
		const trace = (event: AuditInput) => {
			try {
				audit(event);
			} catch {
				/* Report ancillary failures without losing already received usage. */
			}
		};
		const current = new MinimapEngine(
			state,
			{
				read: (lastId, recap) => {
					const entries = context.sessionManager.getBranch();
					order = new Map(entries.map((entry, index) => [entry.id, index]));
					return readBatch(entries, lastId, recap);
				},
				request: (choice, prompt, signal, started) =>
					request(context, choice, prompt, signal, started, audit),
				changed,
				settled: (result, phase) => {
					if (result.callId)
						trace({
							id: result.callId,
							phase,
							at: Date.now(),
							stateEntryId:
								phase === "applied"
									? context.sessionManager.getLeafId?.()
									: undefined,
						});
				},
				accounted: (result) => {
					if (result.callId)
						trace({
							id: result.callId,
							phase: "accounting",
							at: Date.now(),
							usage: structuredClone(current.state.usage),
						});
					if (engine !== current && engine?.state.usage === current.state.usage)
						engine.persist();
				},
				save: (snapshot) => {
					if (engine === current)
						pi.appendEntry(STATE_TYPE, { ...snapshot, usageSessionId: id });
				},
			},
			setting("PI_MINIMAP_INTERVAL_MS", 30000, 2000, 60000),
		);
		engine = current;
		const ui = context.ui as ExtensionContext["ui"] & SidebarUI;
		if (context.mode !== "tui") return;
		mount();
		const inputOff = ui.onEditorInput?.((data) => {
			const action = shortcut(data);
			if (!action) return;
			if (action === "toggle") toggle();
			if (action === "model") current.switchModel();
			return { consume: true };
		});
		const pointerOff = ui.onTerminalInput?.((data) => {
			if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data)) view?.clearHover();
			return undefined;
		});
		unsubscribe = () => {
			stopAgeTimer();
			inputOff?.();
			pointerOff?.();
		};
	}
	pi.on("session_start", load);
	pi.on("session_tree", load);
	pi.on("session_compact", () => {
		engine?.schedule();
		changed();
	});
	pi.on("session_shutdown", () => {
		engine?.dispose();
		unsubscribe?.();
		unsubscribe = undefined;
		(ctx?.ui as SidebarUI | undefined)?.setSidebar?.("pi-minimap", undefined);
		view = undefined;
		ctx = undefined;
	});
	pi.on("agent_start", () => {
		streaming = true;
		idleStatus = "Idle";
		changed();
	});
	pi.on("agent_end", () => {
		streaming = false;
		tools.clear();
		engine?.schedule(true);
		changed();
	});
	pi.on("message_end", (event) =>
		engine?.schedule(
			event.message.role === "toolResult" && event.message.isError,
		),
	);
	pi.on("tool_execution_start", (event) => {
		tools.set(event.toolCallId, event.toolName);
		if (["ask_user_question", "contact_supervisor"].includes(event.toolName))
			engine?.schedule(true);
		if (event.toolName === "goal_wait" && record(event.args)) {
			const labels: Record<string, string> = {
				user: "Waiting for you",
				background: "Waiting for background work",
				external: "Waiting for an external event",
			};
			const label = labels[String(event.args.waiting_for)];
			if (label) waits.set(event.toolCallId, label);
		}
		changed();
	});
	pi.on("tool_execution_end", (event) => {
		if (!event.isError && waits.has(event.toolCallId))
			idleStatus = waits.get(event.toolCallId)!;
		if (!event.isError && event.toolName === "goal_blocked")
			idleStatus = "Blocked";
		waits.delete(event.toolCallId);
		tools.delete(event.toolCallId);
		engine?.schedule(
			event.isError ||
				["goal_complete", "goal_blocked", "goal_wait"].includes(event.toolName),
		);
		changed();
	});
	pi.registerShortcut("alt+m", {
		description: "Toggle minimap",
		handler: async () => toggle(),
	});
	pi.registerShortcut("alt+shift+m", {
		description: "Switch minimap model",
		handler: async () => {
			engine?.switchModel();
		},
	});
	pi.registerCommand("minimap", {
		description:
			"Semantic sidebar: /minimap [on|off|model|refresh|history]. Ctrl+M/Ctrl+Shift+M with distinct Kitty keys, or Alt+m/Alt+Shift+m.",
		handler: async (args, context) => {
			if (context.mode !== "tui") {
				context.ui.notify("Minimap requires fullscreen TUI mode.", "warning");
				return;
			}
			if (
				!engine ||
				ctx?.sessionManager.getSessionId() !==
					context.sessionManager.getSessionId()
			)
				load({}, context);
			const action = args.trim().toLowerCase();
			if (action === "history" || action === "log") {
				await showHistory(context);
				return;
			}
			if (action === "" || action === "toggle") toggle();
			else if (action === "on" || action === "off") {
				if (engine!.state.enabled !== (action === "on")) toggle();
			} else if (action === "model") engine!.switchModel();
			else if (action === "refresh") engine!.schedule(true);
			else
				context.ui.notify(
					"Usage: /minimap [on|off|model|refresh|history]",
					"warning",
				);
		},
	});
}
