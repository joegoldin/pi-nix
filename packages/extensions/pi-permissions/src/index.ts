import { PendingAuthority } from "./engine/authority/pending-authority.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { coversDirectoryRequest, requestedDirectories } from "./directory-access.ts";
import { asForwardedToolCall } from "./engine/authority/forwarded-tool-call.ts";
import { DirectoryGrantStore } from "./directory-store.ts";
import { directoryCandidates, validateDirectoryProposal } from "./directory-proposal.ts";
import { proposeDirectoryAccess, serializeClassifierAction } from "./auto/classifier.ts";
import { resolvePathForPolicy } from "./auto/paths.ts";
import { join } from "node:path";
import { createForwardedGate } from "./forwarded-gate.ts";
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
// afterwards. Shell approvals inform the classifier through bounded scopes;
// non-shell calls retain exact session overrides. The agent is told to retry.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutoModeControls, type PiAutomodeOptions, createPiAutomode } from "./auto/extension.ts";
import { withPermissionChain } from "./auto/permission-chain.ts";
import { approvalLabel, approvalScope, type ApprovalReview, type Denial, type PermissionRecord, PermissionLedger } from "./denials.ts";
import { denialGuidance, registerApprovalRequest } from "./approval-request.ts";
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

interface ToolCallEventLike {
	toolCallId?: string;
	toolName?: string;
	input?: unknown;
}

type ToolCallResult = { block?: boolean; reason?: string } | undefined | void;
type ToolCallHandler = (event: ToolCallEventLike, ctx: ExtensionContext) => ToolCallResult | Promise<ToolCallResult>;

/** Internal commands captured under /permissions instead of exposed as competing entry points. */
const MENU_COMMANDS: Record<string, MenuTab> = {
	automode: "auto",
	"auto-mode": "auto",
	"permission-system": "settings",
};

type MenuCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

/** An interruption to steer is neither a refusal nor something to approve later. */
function wasInterruption(reason: string): boolean {
	return /interrupted the turn/i.test(reason);
}

export default function piPermissions(pi: ExtensionAPI, autoOverrides: Pick<PiAutomodeOptions, "loadConfig" | "classifyAction"> & { directoryStore?: DirectoryGrantStore; proposeDirectories?: typeof proposeDirectoryAccess } = {}): void {
	const probe = { loaded: false };
	pi.events.emit(PROBE, probe);
	if (probe.loaded) return;
	pi.events.on(PROBE, (data) => {
		(data as { loaded: boolean }).loaded = true;
	});

	const ledger = new PermissionLedger();
	const persist = () => pi.appendEntry(LEDGER_ENTRY, ledger.snapshot());
	const forwarded = createForwardedGate(ledger, persist);
	const requestDetails = new AsyncLocalStorage<Record<string, unknown>>();
	// Receipts belong to native request objects, never to model-supplied fields.
	const nativeDirectoryApprovals = new WeakMap<object, () => boolean>();
	function nativeRequest(): Record<string, unknown> | undefined {
		const details = requestDetails.getStore();
		const owner = forwarded.owner();
		if (details?.forwarding && (!owner?.sessionId || !owner.cwd || !asForwardedToolCall(details.toolCall))) return;
		return details;
	}
	const reviewContext = new AsyncLocalStorage<ApprovalReview>();
	const directories = (cwd: string, toolName?: string, input?: unknown) => requestedDirectories(requestDetails.getStore(), cwd,
		toolName && input && typeof input === "object" && !Array.isArray(input) ? { toolName, input: input as Record<string, unknown> } : undefined);
	const directoryStore = autoOverrides.directoryStore ?? new DirectoryGrantStore(join(getAgentDir(), "permissions", "directory-grants"));
	let launchFolder: string | undefined;
	const workspace = (cwd: string) => launchFolder ??= resolvePathForPolicy(cwd) ?? cwd;
	function refreshSaved(cwd: string): void {
		const folder = workspace(cwd);
		ledger.refreshSaved(folder, []);
		try { ledger.refreshSaved(folder, directoryStore.load(folder)); }
		catch { /* Unreadable saved approvals grant nothing; session approvals remain available. */ }
	}
	const clearSimilar = () => {
		if (ledger.clearSimilar()) persist();
	};
	// New operator intent can narrow earlier approval. Do not let a cached scope
	// outrun a later instruction; exact overrides remain individually revocable.
	pi.on("input", (event) => {
		if (event.source !== "extension") {
			if (ledger.clearRejected()) persist();
			clearSimilar();
		}
	});
	pi.events.on("pi-user-decision:submitted", clearSimilar);

	// Each half's tool_call handler runs only for calls not already approved,
	// and every block it returns is recorded.
	const gate =
		(handler: ToolCallHandler): ToolCallHandler =>
		async (event, ctx) => {
			refreshSaved(ctx.cwd);
			if (event.toolName && ledger.wasRejected(event.toolName, event.input, ctx.cwd, forwarded.owner()))
				return { block: true, reason: "The user declined this action. No repeated approval question was opened. Wait for a new instruction or an explicit approval in /permissions; independent work can continue." };
			if (event.toolName && ledger.isGranted(event.toolName, event.input)) return undefined;
			const review: ApprovalReview = { eligible: false, response: "unasked" };
			const result = await reviewContext.run(review, () => handler(event, ctx));
			if (!result?.block || !event.toolName) return result;
			const reason = result.reason ?? "";
			if (wasInterruption(reason)) return result;
			const denial = ledger.open().find(d => !d.owner && d.toolCallId === event.toolCallId && d.toolName === event.toolName)
				?? ledger.record({ toolCallId: event.toolCallId ?? "", toolName: event.toolName, input: event.input ?? {}, reason, directories: review.directories, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), review: { ...review } });
			persist();
			// Only where someone can open the menu; a headless session's agent
			// would be told of a way out it cannot use.
			return ctx.hasUI && ctx.mode === "tui" ? { ...result, reason: reason + denialGuidance(denial) } : result;
		};
	const menuCommands = new Map<MenuTab, MenuCommand>();
	const gated = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "on") {
				return (event: string, handler: unknown) =>
					target.on(event as never, (event === "tool_call" ? gate(handler as ToolCallHandler) : handler) as never);
			}
			if (property === "registerCommand") {
				return (name: string, command: MenuCommand) => {
					const tab = MENU_COMMANDS[name];
					if (tab) menuCommands.set(tab, command);
					else target.registerCommand(name, command);
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
	const pendingAnalysis = new PendingAuthority(
		() => settingsController?.config.current().yoloMode === true,
		listener => settingsController?.config.subscribe?.(listener) ?? (() => {}),
	);
	pi.on("session_start", () => pendingAnalysis.cancel());
	pi.on("session_shutdown", () => pendingAnalysis.cancel());
	withPermissionChain(createPiAutomode({
		...autoOverrides,
		reviewAnalysis: async (ctx, ask) => {
			const decision = await pendingAnalysis.run(ctx.signal, !forwarded.owner(), async signal => {
				const approved = await ask(signal);
				return { approved, state: approved ? "approved" : "denied", decidedBy: { kind: "user", via: "dialog" } };
			});
			return decision.approved ? decision.decidedBy.kind === "yolo" ? "yolo" : "user" : undefined;
		},
		onControls: (controls) => (autoControls = controls),
		onDenied: (review) => {
			const current = reviewContext.getStore();
			if (current) Object.assign(current, review);
		},
		approvals: {
			prepare: async (ctx, config, toolName, input, loadedContext) => {
				const candidates = directoryCandidates(directories(ctx.cwd, toolName, input), toolName, input, ctx.cwd);
				if (!candidates.length || candidates.length > 8) return;
				const owner = forwarded.owner();
				const folder = workspace(ctx.cwd);
				const sessionId = ctx.sessionManager.getSessionId();
				const suggest = autoOverrides.proposeDirectories ?? proposeDirectoryAccess;
				const proposal = await suggest(ctx, config, serializeClassifierAction(toolName, input), loadedContext, candidates);
				const selected = validateDirectoryProposal(proposal, candidates) ?? candidates.map(({ path, access }) => ({ path, access }));
				const review = reviewContext.getStore();
				if (review) review.directories = selected;
				const scope = approvalLabel(toolName, input, ctx.cwd, selected);
				if (!scope) return;
				return {
					scope,
					...(!owner ? { futureScope: `Save only these folder permissions for sessions started in ${folder}. Command-specific approvals do not persist. Revoke later in /permissions.` } : {}),
					remember: (future: boolean) => {
						if (ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== sessionId || (future && owner) || selected.some(directory => resolvePathForPolicy(directory.path) !== directory.path)) return false;
						try {
							if (future) for (const directory of selected) directoryStore.save(folder, directory);
							// Expire previous command intent before recording this answer.
							pi.events.emit("pi-user-decision:submitted", { source: "permission-approval" });
							if (future) {
								refreshSaved(ctx.cwd);
								if (toolName === "bash" || toolName === "bg_run") ledger.approveSimilar(toolName, input, ctx.cwd);
							} else ledger.rememberScope(toolName, input, ctx.cwd, selected, owner);
							persist();
							return true;
						} catch {
							ctx.ui.notify("Could not save the permission scope. Review /permissions before retrying; some folder grants may have been saved.", "error");
							return false;
						}
					},
				};
			},
			context: (toolName, cwd, input) => {
				refreshSaved(cwd);
				const owner = forwarded.owner();
				const call = { toolName, input, cwd };
				const grants = ledger.directoryApprovals(owner, call);
				const details = nativeRequest();
				if (details && coversDirectoryRequest(details, grants)) nativeDirectoryApprovals.set(details, () => {
					// Recheck saved access after this request's model review.
					refreshSaved(cwd);
					return coversDirectoryRequest(details, ledger.directoryApprovals(owner, call));
				});
				return [...ledger.scenarioApprovals(toolName, cwd, forwarded.owner()), ...grants];
			},
			confirmed: () => {
				const details = nativeRequest();
				if (details) nativeDirectoryApprovals.set(details, () => true);
			},
			scope: (toolName, input, cwd) => approvalLabel(toolName, input, cwd, directories(cwd, toolName, input)),
			has: (toolName, input, cwd) => ledger.isSimilarlyGranted(toolName, input, cwd, forwarded.owner()),
			remember: (toolName, input, cwd) => {
				ledger.rememberScope(toolName, input, cwd, directories(cwd, toolName, input), forwarded.owner());
				persist();
			},
		},
	}), {
		wrapForwarded: forwarded.wrap,
		wrapRequest: (handler, details) => (event, ctx) => requestDetails.run(details, async () => {
			const signal = details.signal instanceof AbortSignal
				? ctx.signal ? AbortSignal.any([ctx.signal, details.signal]) : details.signal
				: ctx.signal;
			const result = await handler(event, { ...ctx, signal });
			const requested = reviewContext.getStore()?.directories ?? directories(ctx.cwd, event.toolName, event.input);
			if (!details.forwarding && result?.block && requested.length && !wasInterruption(result.reason ?? "")) {
				ledger.record({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, reason: result.reason ?? "", directories: requested, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), review: { ...(reviewContext.getStore() ?? { eligible: false, response: "unasked" }) } });
				persist();
			}
			return result;
		}),
	})(gated);
	permissionSystem(gated, {
		onForwardedDecision: forwarded.recordDecision,
		onSettings: (controller) => (settingsController = controller),
		consumeNativeDirectoryApproval: (details) => {
			const approved = nativeDirectoryApprovals.get(details);
			nativeDirectoryApprovals.delete(details);
			return approved?.() ?? false;
		},
	});
	registerApprovalRequest(pi, ledger, persist);

	function restoreLedger(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getBranch() as { type?: string; customType?: string; data?: unknown }[];
		const last = [...entries].reverse().find((e) => e.type === "custom" && e.customType === LEDGER_ENTRY);
		ledger.restore(last?.data as PermissionRecord | undefined);
		refreshSaved(ctx.cwd);
	}

	pi.on("session_tree", (_event, ctx) => restoreLedger(ctx));
	let unrequire: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		unrequire?.();
		const sessionId = ctx.sessionManager.getSessionId?.();
		unrequire = sessionId ? requireInChildren(sessionId) : undefined;
		restoreLedger(ctx);
	});

	pi.on("session_shutdown", () => {
		unrequire?.();
		unrequire = undefined;
	});

	function approve(denial: Denial, ctx: ExtensionContext, exact = false): void {
		if (denial.policyDenied) {
			ctx.ui.notify("An explicit permission rule denied this child call. Menu approval cannot override that rule.", "warning");
			return;
		}
		if (denial.incomplete || (denial.owner && !denial.owner.sessionId)) {
			ctx.ui.notify("This child request lacks complete call metadata. Retry it with the updated child runtime before approving.", "warning");
			return;
		}
		const cwd = denial.owner?.cwd ?? ctx.cwd;
		const directoryScope = !exact && denial.directories?.length ? { label: approvalLabel(denial.toolName, denial.input, cwd, denial.directories)! } : undefined;
		const scope = directoryScope ?? (!exact && (!denial.owner || denial.owner.cwd) && (denial.toolName === "bash" || denial.toolName === "bg_run") ? approvalScope(denial.toolName, denial.input, cwd) : undefined);
		ledger.approve(denial.id, exact ? undefined : ctx.cwd);
		persist();
		const { title, target } = callLabel(denial.toolName, denial.input);
		const input = JSON.stringify(denial.input);
		pi.sendMessage(
			{
				customType: APPROVED_MESSAGE,
				content:
					`The user approved a call that was blocked earlier: ${title}(${target}). ` +
					(scope ? `Approved scope: ${scope.label}. Deterministic restrictions still apply; variants are reviewed by the auto classifier. ` :
					`It is now allowed for the rest of this session, exactly as written (tool "${denial.toolName}", input ${input.length > 4000 ? `${input.slice(0, 4000)}…` : input}). `) +
					(denial.owner
						? `This approval belongs only to child ${denial.owner.agentName} (session ${denial.owner.sessionId}), not to you or any sibling. Tell that child to retry if still needed; do not execute this call in the parent.`
						: "If it is still needed, retry it now."),
				display: true,
				details: { toolName: denial.toolName, input: denial.input, owner: denial.owner },
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
	async function carryOut(effect: MenuEffect, ctx: ExtensionContext): Promise<"model" | undefined> {
		switch (effect.kind) {
			case "approve-exact":
			case "approve":
				approve(effect.denial, ctx, effect.kind === "approve-exact");
				return undefined;
			case "dismiss":
				ledger.dismiss(effect.denial.id);
				persist();
				return undefined;
			case "revoke":
				if (effect.grant.savedFor && effect.grant.directory) {
					try { directoryStore.revoke(effect.grant.savedFor, effect.grant.directory); }
					catch { ctx.ui.notify("Could not revoke the saved permission; no change was made.", "error"); return undefined; }
				}
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
	function showMenu(ctx: ExtensionContext, tab: MenuTab): Promise<"model" | undefined> {
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
				Date.now,
				ctx.cwd,
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

	async function openPermissions(ctx: ExtensionContext, tab: MenuTab): Promise<void> {
		let next: MenuTab | undefined = tab;
		while (next) {
			refreshSaved(ctx.cwd);
			const wanted = await showMenu(ctx, next);
			next = undefined;
			if (wanted === "model" && autoControls) {
				await autoControls.run("model", ctx);
				next = "auto";
			}
		}
	}

	pi.registerShortcut("ctrl+p", {
		description: "Open permissions",
		handler: async (ctx) => {
			if (ctx.mode === "tui") await openPermissions(ctx, "denied");
		},
	});

	pi.registerCommand("permissions", {
		description: "Permissions in one place: blocked calls, approvals, auto mode and settings",
		getArgumentCompletions: async (prefix) => {
			for (const route of ["auto", "settings"] as const) {
				if (!prefix.startsWith(`${route} `)) continue;
				const items = await menuCommands.get(route)?.getArgumentCompletions?.(prefix.slice(route.length + 1));
				return items?.map((item) => ({ ...item, value: `${route} ${item.value}` })) ?? null;
			}
			const items = ["auto", "settings", "approve last"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [route, ...rest] = args.trim().split(/\s+/);
			if (route === "auto" || route === "settings") {
				const subcommand = rest.join(" ");
				if (!subcommand && ctx.mode === "tui") await openPermissions(ctx, route);
				else await menuCommands.get(route)!.handler(subcommand, ctx);
				return;
			}
			if (args.trim() === "approve last") {
				const latest = ledger.open()[0];
				if (!latest) ctx.ui.notify("Nothing blocked is waiting.", "info");
				else approve(latest, ctx);
				return;
			}
			if (route) {
				ctx.ui.notify("Usage: /permissions [auto [command]|settings [command]|approve last]", "info");
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
