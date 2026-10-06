// pi-custom's intercom part: messaging between this session and other agent
// sessions on the machine, pi or Claude Code.
//
//   runtime.ts        one session's peers, inbox, asks and replies; the
//                     pi-subagents contract
//   tool.ts           the `intercom` tool
//   peers.ts          rosters, target resolution, list text (pure)
//   reply-tracker.ts  which inbound asks are owed an answer (pure)
//   handover.ts       session summaries for /handover and action "handover"
//   render.ts         how an inbound message is drawn
//   config.ts         intercom/config.json, written by pi-nix's messaging option
//   broker/           the pi↔pi transport, ported from pi-intercom
//   claude/           the pi↔Claude Code transport
//
// Registers nothing unless intercom/config.json exists (see config.ts). Replaces pi-intercom
// and pi-claude-link.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { type InboundDetails, messageLines } from "./render.ts";
import { Intercom, type ToolResult } from "./runtime.ts";
import { registerIntercomTool } from "./tool.ts";
import { resolveTarget } from "./peers.ts";

function firstText(result: ToolResult): string {
	return result.content[0]?.text.replace(/\*\*/g, "") ?? "";
}

function failed(result: ToolResult): boolean {
	return result.details.error === true || result.details.delivered === false;
}

export default function intercom(pi: ExtensionAPI): void {
	const config = loadConfig();
	if (!config.enabled) {
		// Nothing registered: a tool that can only fail would cost every prompt
		// its description. A config that asked for intercom but could not be read
		// says so once.
		if (config.disabledReason) {
			let warned = false;
			pi.on("session_start", (_event, ctx) => {
				if (warned || !ctx.hasUI) return;
				warned = true;
				ctx.ui.notify(`Intercom is off: ${config.disabledReason}`, "warning");
			});
		}
		return;
	}
	let runtime: Intercom | null = null;
	let unsubscribe: (() => void) | null = null;

	registerIntercomTool(pi, () => runtime);

	pi.registerMessageRenderer("intercom_message", (message, options, theme) => {
		const details = message.details as InboundDetails | undefined;
		if (!details?.message) return undefined;
		return { render: (width: number) => messageLines(details, width, !options.expanded, theme), invalidate() {} };
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "intercom" || !event.details || typeof event.details !== "object") return;
		const details = event.details as { error?: unknown; delivered?: unknown };
		if (details.error === true || details.delivered === false) return { isError: true };
	});

	pi.on("session_start", (_event, ctx) => {
		if (!runtime) {
			runtime = new Intercom(pi, config);
			unsubscribe = runtime.subscribe();
		}
		runtime.start(ctx);
	});

	pi.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = null;
		const current = runtime;
		runtime = null;
		await current?.shutdown();
	});

	pi.on("turn_start", (_event, ctx) => runtime?.turnStart(ctx));
	pi.on("turn_end", (event, ctx) => {
		const m = event.message as { role?: string; stopReason?: string };
		runtime?.turnEnd(ctx, m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error");
	});
	pi.on("agent_start", () => runtime?.agentStart());
	pi.on("agent_end", () => runtime?.agentEnd());
	pi.on("tool_execution_start", (event) => runtime?.toolStart(event.toolCallId, event.toolName));
	pi.on("tool_execution_end", (event) => runtime?.toolEnd(event.toolCallId));
	pi.on("model_select", (event) => runtime?.modelChanged(event.model.id));

	async function pickPeer(ctx: ExtensionContext, title: string): Promise<string | undefined> {
		const r = runtime;
		if (!r) return undefined;
		let roster;
		try {
			roster = await r.roster();
		} catch (error) {
			ctx.ui.notify(`Intercom unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
		const options = new Map<string, string>();
		for (const s of roster.pi) {
			if (s.id === roster.self.id) continue;
			options.set(`${s.name || "Unnamed session"} — pi · ${s.cwd} [${s.status ?? "?"}]`, `pi:${s.id}`);
		}
		for (const c of roster.claude) options.set(`${c.name} — Claude Code · ${c.cwd} [${c.status ?? "?"}]`, c.address);
		if (options.size === 0) {
			ctx.ui.notify(roster.claudeNote ? `No other sessions. ${roster.claudeNote}` : "No other sessions.", "info");
			return undefined;
		}
		const choice = await ctx.ui.select(title, [...options.keys()]);
		return choice === undefined ? undefined : options.get(choice);
	}

	async function compose(ctx: ExtensionContext): Promise<void> {
		const r = runtime;
		if (!r || !ctx.hasUI) return;
		const to = await pickPeer(ctx, "Message which session?");
		if (!to) return;
		const body = (await ctx.ui.editor("Message", ""))?.trim();
		if (!body) return;
		const result = await r.send(ctx, { to, message: body });
		ctx.ui.notify(firstText(result), failed(result) ? "error" : "info");
	}

	pi.registerCommand("intercom", {
		description: "Message another pi or Claude Code session on this machine",
		handler: async (_args, ctx) => compose(ctx),
	});

	pi.registerShortcut("alt+m", {
		description: "Message another session",
		handler: async (ctx) => compose(ctx),
	});

	pi.registerCommand("intercom-id", {
		description: "Insert an intercom snippet addressing this session into the editor",
		handler: async (_args, ctx) => {
			const id = runtime?.sessionId;
			if (!id) {
				ctx.ui.notify("Intercom has not started yet.", "warning");
				return;
			}
			const snippet = `Use intercom: intercom({ action: "send", to: "${id}", message: "..." })`;
			const existing = ctx.ui.getEditorText?.() ?? "";
			ctx.ui.setEditorText?.(existing.trim() ? `${existing.trimEnd()}\n\n${snippet}` : snippet);
		},
	});

	pi.registerCommand("handover", {
		description: "Summarize this session and hand it to another session: /handover [target] [next task]",
		handler: async (args, ctx) => {
			const r = runtime;
			if (!r || !ctx.hasUI) {
				ctx.ui.notify("/handover needs the terminal UI; the intercom tool's handover action works elsewhere.", "warning");
				return;
			}
			const input = args.trim();
			let to: string | undefined = input.split(/\s+/, 1)[0] || undefined;
			let goal = to ? input.slice(to.length).trim() || undefined : undefined;
			if (to) {
				// A first word that names no session is the start of the task, not a target.
				const roster = await r.roster().catch(() => undefined);
				if (roster && !resolveTarget(to, roster.pi, roster.claude).ok) {
					goal = input;
					to = undefined;
				}
			}
			to ??= await pickPeer(ctx, "Hand over to which session?");
			if (!to) return;
			ctx.ui.notify("Generating handover…", "info");
			let draft: string;
			try {
				draft = await r.handoverText(ctx, goal);
			} catch (error) {
				ctx.ui.notify(`Handover failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const edited = (await ctx.ui.editor("Edit handover", draft))?.trim();
			if (!edited) {
				ctx.ui.notify("Handover cancelled", "info");
				return;
			}
			const result = await r.handover(ctx, { to, text: edited });
			ctx.ui.notify(failed(result) ? firstText(result) : `Handover: ${firstText(result)}`, failed(result) ? "error" : "info");
		},
	});
}
