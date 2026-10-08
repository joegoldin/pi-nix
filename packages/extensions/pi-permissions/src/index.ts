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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import autoMode from "./auto/index.ts";
import { type Denial, type PermissionRecord, PermissionLedger } from "./denials.ts";
import permissionSystem from "./engine/index.ts";
import { callLabel } from "./ui/call-label.ts";
import { framedMenu, type MenuTheme, PermissionsMenuView } from "./ui/menu.ts";
import { type MenuEffect, PermissionsMenu } from "./ui/menu-state.ts";

// Asked on the session's event bus before registering. A subagent can be
// handed this package twice, by path: pi-subagents passes its npm link, and
// settings.json's packages list passes the store path. pi de-duplicates by the
// path as written, so both would load and the second would fail on a tool name
// the first registered. The bus is the session's own, and runs a handler
// synchronously up to its first await, so the copy that loaded first answers
// before the second registers anything.
const PROBE = "pi-permissions:loaded";

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
	const gated = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "on") {
				return (event: string, handler: unknown) =>
					target.on(event as never, (event === "tool_call" ? gate(handler as ToolCallHandler) : handler) as never);
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	// In the order the two packages were loaded: auto mode's tool_call handler
	// runs first, so its deterministic denials stop a call before the
	// permission system prompts for it.
	autoMode(gated);
	permissionSystem(gated);

	pi.on("session_start", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries() as { type?: string; customType?: string; data?: unknown }[];
		const last = [...entries].reverse().find((e) => e.type === "custom" && e.customType === LEDGER_ENTRY);
		ledger.restore(last?.data as PermissionRecord | undefined);
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

	function carryOut(effect: MenuEffect, ctx: ExtensionContext): void {
		switch (effect.kind) {
			case "approve":
				approve(effect.denial, ctx);
				return;
			case "dismiss":
				ledger.dismiss(effect.denial.id);
				persist();
				return;
			case "revoke":
				ledger.revoke(effect.grant.key);
				persist();
				return;
			case "close":
				return;
		}
	}

	pi.registerCommand("permissions", {
		description: "Approve calls that were blocked, or revoke ones you approved",
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
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const menu = new PermissionsMenu(ledger);
				const view = new PermissionsMenuView(
					menu,
					theme as unknown as MenuTheme,
					(effect) => {
						if (effect.kind === "close") done();
						else carryOut(effect, ctx);
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
		},
	});
}
