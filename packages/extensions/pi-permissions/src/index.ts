// pi-permissions: permissions and auto mode for pi in one extension.
//
// Two engines, vendored (see ATTRIBUTION.md): engine/ is pi-permission-system,
// the policy rules, gates, authorizer chain, prompt, session grants and
// subagent forwarding; auto/ is pi-automode, the classifier and the
// deterministic checks in front of it. Auto mode joins the permission system's
// authorizer chain as a link (auto/permission-chain.ts), as it did when the two
// were separate packages, so an ask the rules raise goes to the classifier
// before it reaches you.
//
// Around both, this file keeps a ledger (denials.ts): every call either half
// blocks is recorded with its input, and /permissions lets you approve one
// afterwards. An approved call passes both halves for the rest of the session,
// and the agent is told, so it retries.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutoModeControls, createPiAutomode } from "./auto/extension.ts";
import { withPermissionChain } from "./auto/permission-chain.ts";
import { type Denial, type PermissionRecord, PermissionLedger } from "./denials.ts";
import { applySetting, buildSettingItems, type PermissionSystemConfigController } from "./engine/config/config-modal.ts";
import permissionSystem from "./engine/index.ts";
import { callLabel } from "./ui/call-label.ts";
import { framedMenu, type MenuTheme, PermissionsMenuView } from "./ui/menu.ts";
import { type MenuEffect, type MenuTab, PermissionsMenu, type SettingRow } from "./ui/menu-state.ts";

// Asked on the session's event bus before registering. A subagent can be
// handed this package twice, by path: pi-subagents passes its npm link, and
// settings.json's packages list passes the store path. pi de-duplicates by the
// path as written, so both would load and the second would fail on a tool name
// the first registered. The bus is the session's own, and runs a handler
// synchronously up to its first await, so the copy that loaded first answers
// before the second registers anything.
const PROBE = "pi-permissions:loaded";

// pi-subagents' registry of extensions every child of a session must load
// (its src/shared/required-child-extensions.js, version 1). A child launched
// without one that is required fails to start rather than running, and no
// agent default, override or empty extension list removes it; with
// requireForAllRunners a child is also refused on a runner that cannot load
// it. pi-permissions registers itself for each session, so every subagent is
// gated, and a child registers itself for its own children in turn.
const REQUIRED_CHILD_EXTENSIONS = Symbol.for("pi-subagents.required-child-extensions.v1");
const ENTRY_PATH = realpathSync(fileURLToPath(import.meta.url));

interface RequiredChildEntry {
	id: string;
	path: string;
	requireForAllRunners?: true;
}

/** Make every child of `sessionId` load this extension. Returns the undo. */
export function requireInChildren(sessionId: string, root: Record<symbol, unknown> = globalThis as never): () => void {
	let store = root[REQUIRED_CHILD_EXTENSIONS] as { version?: unknown; bySession?: unknown } | undefined;
	if (store === undefined) {
		store = { version: 1, bySession: new Map() };
		root[REQUIRED_CHILD_EXTENSIONS] = store;
	}
	if (store.version !== 1 || !(store.bySession instanceof Map)) {
		throw new Error("pi-subagents' required child extension registry has an unknown shape; refusing to leave subagents ungated.");
	}
	const bySession = store.bySession as Map<string, readonly RequiredChildEntry[]>;
	const own: RequiredChildEntry = Object.freeze({ id: "pi-permissions", path: ENTRY_PATH, requireForAllRunners: true as const });
	const others = (bySession.get(sessionId) ?? []).filter((entry) => entry.id !== own.id);
	const entries = Object.freeze([...others, own]);
	bySession.set(sessionId, entries);
	return () => {
		const current = bySession.get(sessionId);
		if (!current) return;
		const rest = current.filter((entry) => entry !== own);
		if (rest.length) bySession.set(sessionId, Object.freeze(rest));
		else bySession.delete(sessionId);
	};
}

/** Where the ledger is kept in the session. */
const LEDGER_ENTRY = "pi-permissions";
/** The message that tells the agent a blocked call was approved. */
const APPROVED_MESSAGE = "pi-permissions:approved";

/** Said to the agent after a block it can be approved out of. */
const APPROVABLE =
	" The user can approve this exact call from /permissions; if they tell you to go ahead, retry it.";

interface ToolCallEventLike {
	toolCallId?: string;
	toolName?: string;
	input?: unknown;
}

type ToolCallResult = { block?: boolean; reason?: string } | undefined | void;
type ToolCallHandler = (event: ToolCallEventLike, ctx: ExtensionContext) => ToolCallResult | Promise<ToolCallResult>;

/** The two halves' own commands, which open /permissions on their tab when given no arguments. */
const MENU_COMMANDS: Record<string, MenuTab> = {
	automode: "auto",
	"auto-mode": "auto",
	"permission-system": "settings",
};

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

/** An interruption to steer is neither a refusal nor something to approve later. */
function wasInterruption(reason: string): boolean {
	return /interrupted the turn/i.test(reason);
}

export default function piPermissions(pi: ExtensionAPI): void {
	const probe = { loaded: false };
	pi.events.emit(PROBE, probe);
	if (probe.loaded) return;
	pi.events.on(PROBE, (data) => {
		(data as { loaded: boolean }).loaded = true;
	});

	const ledger = new PermissionLedger();
	const persist = () => pi.appendEntry(LEDGER_ENTRY, ledger.snapshot());

	// Each half's tool_call handler runs only for calls not already approved,
	// and every block it returns is recorded.
	const gate =
		(handler: ToolCallHandler): ToolCallHandler =>
		async (event, ctx) => {
			if (event.toolName && ledger.isGranted(event.toolName, event.input)) return undefined;
			const result = await handler(event, ctx);
			if (!result?.block || !event.toolName) return result;
			const reason = result.reason ?? "";
			if (wasInterruption(reason)) return result;
			ledger.record({ toolCallId: event.toolCallId ?? "", toolName: event.toolName, input: event.input ?? {}, reason });
			persist();
			// Only where someone can open the menu; a headless session's agent
			// would be told of a way out it cannot use.
			return ctx.hasUI && ctx.mode === "tui" ? { ...result, reason: reason + APPROVABLE } : result;
		};
	// Late-bound: the commands below are registered before openPermissions exists.
	let openPermissions: (ctx: ExtensionCommandContext, tab: MenuTab) => Promise<void> = async () => {};
	const gated = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "on") {
				return (event: string, handler: unknown) =>
					target.on(event as never, (event === "tool_call" ? gate(handler as ToolCallHandler) : handler) as never);
			}
			if (property === "registerCommand") {
				return (name: string, command: { handler: CommandHandler; description?: string }) => {
					const tab = MENU_COMMANDS[name];
					if (!tab) return target.registerCommand(name, command as never);
					// With arguments the command does what it always did; on its own it
					// opens the one menu, on its tab.
					return target.registerCommand(name, {
						...command,
						description: `${command.description ?? ""} (no arguments: /permissions)`.trim(),
						handler: (args: string, ctx: ExtensionCommandContext) =>
							args.trim() || ctx.mode !== "tui" ? command.handler(args, ctx) : openPermissions(ctx, tab),
					} as never);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	// In the order the two packages were loaded: auto mode's tool_call handler
	// runs first, so its deterministic denials stop a call before the
	// permission system prompts for it.
	let autoControls: AutoModeControls | undefined;
	let settingsController: PermissionSystemConfigController | undefined;
	withPermissionChain(createPiAutomode({ onControls: (controls) => (autoControls = controls) }))(gated);
	permissionSystem(gated, { onSettings: (controller) => (settingsController = controller) });

	let unrequire: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		unrequire?.();
		const sessionId = ctx.sessionManager.getSessionId?.();
		unrequire = sessionId ? requireInChildren(sessionId) : undefined;
		const entries = ctx.sessionManager.getEntries() as { type?: string; customType?: string; data?: unknown }[];
		const last = [...entries].reverse().find((e) => e.type === "custom" && e.customType === LEDGER_ENTRY);
		ledger.restore(last?.data as PermissionRecord | undefined);
	});

	pi.on("session_shutdown", () => {
		unrequire?.();
		unrequire = undefined;
	});

	function approve(denial: Denial, ctx: ExtensionContext): void {
		ledger.approve(denial.id);
		persist();
		const { title, target } = callLabel(denial.toolName, denial.input);
		const input = JSON.stringify(denial.input);
		pi.sendMessage(
			{
				customType: APPROVED_MESSAGE,
				content:
					`The user approved a call that was blocked earlier: ${title}(${target}). ` +
					`It is now allowed for the rest of this session, exactly as written (tool "${denial.toolName}", input ${input.length > 4000 ? `${input.slice(0, 4000)}…` : input}). ` +
					"If it is still needed, retry it now.",
				display: true,
				details: { toolName: denial.toolName, input: denial.input },
			},
			ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" },
		);
	}

	pi.registerMessageRenderer(APPROVED_MESSAGE, (message, _options, theme) => {
		const details = message.details as { toolName?: string; input?: unknown } | undefined;
		const { title, target } = callLabel(details?.toolName ?? "", details?.input);
		const text = `${theme.fg("success", "✓")} ${theme.fg("dim", `Approved ${title}${target ? `(${target})` : ""}`)}`;
		return { render: () => [text], invalidate() {} };
	});

	function autoRows(ctx: ExtensionContext): SettingRow[] {
		if (!autoControls) return [];
		const a = autoControls.snapshot(ctx);
		const ask = a.askOnBlock?.enabled ? `on, ${a.askOnBlock.timeoutSeconds}s` : "off";
		return [
			{
				id: "toggle",
				label: "Auto mode",
				value: `${a.enabled ? "on" : "off"}${a.enabledOverride === undefined ? "" : " for this session"}`,
				description: "The classifier judges every call the rules leave open. Off, for this session, leaves them to the permission system alone.",
				actionable: true,
			},
			{
				id: "model",
				label: "Classifier model",
				value: a.classifierModel ?? "this session's model",
				description: "The model that judges calls, saved to auto mode's global config. The one pi-nix sets wins over it.",
				actionable: true,
			},
			{
				id: "ask",
				label: "Ask before a block",
				value: ask,
				description: "Set by pi-nix's autoMode.askOnBlock. Asked only in the terminal UI, never in a headless session.",
				actionable: false,
			},
			{
				id: "counts",
				label: "This session",
				value: `${a.checkedActions} checked · ${a.blockedActions} blocked · classifier ${a.classifierAllowed} allowed, ${a.classifierDenied} denied`,
				actionable: false,
			},
			{ id: "reset", label: "Reset counters", description: "Start this session's counts again.", actionable: true },
			{ id: "reload", label: "Reload config", description: "Read auto mode's config files again.", actionable: true },
			{ id: "log", label: "Decision log", value: a.logEnabled ? a.logFile : "off", actionable: false },
			// The value is cut at the edge; highlighted, the warning reads in full.
			...a.diagnostics.map((d, i) => ({ id: `warning-${i}`, label: "Config warning", value: d, description: d, warning: true, actionable: false })),
		];
	}

	function settingsRows(): SettingRow[] {
		if (!settingsController) return [];
		const items = buildSettingItems(settingsController.config.current()).map((item) => ({
			id: item.id,
			label: item.label,
			value: item.currentValue,
			description: item.description,
			actionable: true,
		}));
		return [
			...items,
			{
				id: "path",
				label: "Config file",
				value: settingsController.configPath,
				description: "pi-nix writes this file each time pi starts, so a change here lasts until then; set it for good in autoMode.permissionSystem.settings.",
				actionable: false,
			},
		];
	}

	/** Carries out what the menu asks; resolves with "model" when the menu must close for the model picker. */
	async function carryOut(effect: MenuEffect, ctx: ExtensionCommandContext): Promise<"model" | undefined> {
		switch (effect.kind) {
			case "approve":
				approve(effect.denial, ctx);
				return undefined;
			case "dismiss":
				ledger.dismiss(effect.denial.id);
				persist();
				return undefined;
			case "revoke":
				ledger.revoke(effect.grant.key);
				persist();
				return undefined;
			case "act":
				if (effect.tab === "settings" && settingsController) {
					const current = settingsController.config.current();
					const item = buildSettingItems(current).find((i) => i.id === effect.row.id);
					if (item) settingsController.config.save(applySetting(current, item.id, item.currentValue === "on" ? "off" : "on"), ctx);
					return undefined;
				}
				if (!autoControls) return undefined;
				if (effect.row.id === "model") return "model";
				if (effect.row.id === "toggle") await autoControls.run(autoControls.snapshot(ctx).enabled ? "off" : "on", ctx);
				if (effect.row.id === "reset") await autoControls.run("reset", ctx);
				if (effect.row.id === "reload") await autoControls.run("reload", ctx);
				return undefined;
			case "close":
				return undefined;
		}
	}

	/** One showing of the menu; resolves with "model" when the model picker is wanted next. */
	function showMenu(ctx: ExtensionCommandContext, tab: MenuTab): Promise<"model" | undefined> {
		return ctx.ui.custom<"model" | undefined>((tui, theme, _keybindings, done) => {
			const menu = new PermissionsMenu(ledger, { auto: () => autoRows(ctx), settings: settingsRows }, tab);
			const view = new PermissionsMenuView(
				menu,
				theme as unknown as MenuTheme,
				(effect) => {
					if (effect.kind === "close") {
						done(undefined);
						return;
					}
					void carryOut(effect, ctx).then((next) => {
						if (next === "model") done("model");
						else {
							menu.settle();
							tui.requestRender();
						}
					});
				},
				() => Math.max(8, Math.floor(tui.terminal.rows * 0.6)),
			);
			const framed = framedMenu(view, theme as unknown as MenuTheme);
			return {
				render: (width: number) => framed.render(width),
				invalidate: () => framed.invalidate(),
				handleInput: (data: string) => {
					framed.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	openPermissions = async (ctx, tab) => {
		let next: MenuTab | undefined = tab;
		while (next) {
			const wanted = await showMenu(ctx, next);
			next = undefined;
			if (wanted === "model" && autoControls) {
				await autoControls.run("model", ctx);
				next = "auto";
			}
		}
	};

	pi.registerCommand("permissions", {
		description: "Permissions in one place: blocked calls, approvals, auto mode and settings",
		handler: async (args, ctx) => {
			if (args.trim() === "approve last") {
				const latest = ledger.open()[0];
				if (!latest) ctx.ui.notify("Nothing blocked is waiting.", "info");
				else approve(latest, ctx);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/permissions needs the terminal UI; /permissions approve last works anywhere.", "error");
				return;
			}
			await openPermissions(ctx, "denied");
		},
	});
}
