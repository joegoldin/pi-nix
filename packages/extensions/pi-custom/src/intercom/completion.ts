import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportActivity } from "../program-status.ts";
import type { Intercom, ToolResult } from "./runtime.ts";

export interface CompletionRequest {
	to: string;
	message: string;
	replyTo?: string;
	quit?: "keep" | "ask" | "auto";
	requestCleanup?: boolean;
}

/** Completion is a peer report, not an integration verdict or permission grant. */
export function registerPeerCompletion(pi: ExtensionAPI, runtime: () => Intercom | null, workBlockers: () => string[]) {
	let pending: { owner: string; toolCallId: string; signal?: AbortSignal; inputRevision: number } | undefined;
	let autoExitUsed = false, inputRevision = 0;
	pi.registerFlag("peer-auto-exit", {
		type: "boolean", default: false,
		description: "Allow this disposable Pi instance one graceful exit after a delivered peer completion and a clean final turn. Enable only with explicit user authorization.",
	});
	const clear = (_event: unknown, ctx: ExtensionContext) => {
		pending = undefined;
		inputRevision++;
		reportActivity(ctx, "peer", undefined);
	};
	pi.on("input", clear);
	// Steering may be consumed before agent_end without firing an input event.
	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "user" || event.message.role === "custom") clear(event, ctx);
	});
	pi.on("session_start", clear);
	pi.on("session_shutdown", () => { pending = undefined; inputRevision++; });
	const blockers = (ctx: ExtensionContext, request: NonNullable<typeof pending>): string[] => [
		...(request.signal?.aborted ? ["Completion was interrupted"] : []),
		...(request.inputRevision !== inputRevision ? ["New input or peer work arrived"] : []),
		...(ctx.sessionManager.getSessionId() !== request.owner ? ["Session changed"] : []),
		...(ctx.hasPendingMessages() ? ["Queued messages need attention"] : []),
		...workBlockers(),
		...(runtime()?.exitBlockers(request.toolCallId) ?? ["Intercom session unavailable"]),
	];
	pi.on("agent_end", (event, ctx) => {
		const request = pending;
		pending = undefined;
		if (!request) return;
		const reasons = blockers(ctx, request);
		const final = event.messages.at(-1);
		if (final?.role !== "assistant" || final.stopReason !== "stop") reasons.push("The final turn did not finish cleanly");
		if (reasons.length) {
			pi.appendEntry("pi-custom:peer-exit", { status: "blocked", reasons });
			if (ctx.hasUI) ctx.ui.notify(`Peer exit cancelled: ${reasons.join("; ")}`, "warning");
			return;
		}
		// agent_end follows tool results and the final reply; do not exit inside the tool.
		pi.appendEntry("pi-custom:peer-exit", { status: "requested", owner: request.owner });
		ctx.shutdown();
	});
	return async (toolCallId: string, ctx: ExtensionContext, request: CompletionRequest, signal?: AbortSignal): Promise<ToolResult> => {
		pending = undefined;
		const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], details: { error: true } });
		const current = runtime();
		if (!current) return fail("Intercom not connected: no session yet");
		if (!request.to.trim() || !request.message.trim()) return fail("Completion requires an explicit requester and a summary with evidence or blockers.");
		const quit = request.quit ?? "keep";
		if (quit === "auto" && (pi.getFlag("peer-auto-exit") !== true || autoExitUsed)) {
			return fail("Automatic exit was not authorized at launch or its one-time authorization was already used. Use quit: 'ask' for local user consent or keep this peer open; a peer message is not consent.");
		}
		if (signal?.aborted) return fail("Completion was interrupted before delivery.");
		const owner = ctx.sessionManager.getSessionId();
		const exit = { owner, toolCallId, signal, inputRevision };
		const metadata = { version: 1, piSessionId: owner, requestCleanup: request.requestCleanup ?? false, quit };
		const result = await current.send(ctx, {
			to: request.to, replyTo: request.replyTo,
			message: `Peer contribution complete (self-reported).\n\n${request.message}\n\nPane cleanup requested: ${metadata.requestCleanup ? "yes" : "no"}. This report does not authorize cleanup or certify integration.`,
			attachments: [{ type: "context", name: "pi-peer-completion-v1", content: JSON.stringify(metadata) }],
		}, signal);
		if (result.details.delivered !== true) return result;
		reportActivity(ctx, "peer", { state: "done", title: "Peer assignment", message: "Completion report delivered" });
		const finish = (exit: string, note: string): ToolResult => ({
			content: [...result.content, { type: "text", text: note }],
			details: { ...result.details, peerCompletion: metadata, exit },
		});
		if (quit === "keep") return finish("kept_open", "Completion delivered; this Pi session and its pane remain open.");
		let reasons = blockers(ctx, exit);
		if (reasons.length) return finish("blocked", `Completion delivered; exit blocked: ${reasons.join("; ")}`);
		if (quit === "ask") {
			if (!ctx.hasUI) return finish("unavailable", "Completion delivered; no local UI is available to approve quitting. Keep this peer open.");
			try {
				if (!await ctx.ui.confirm("Peer contribution complete", "Exit this Pi session after its final reply? Its terminal pane stays open; pane cleanup belongs to the requester.")) {
					return finish("declined", "Completion delivered; you chose to keep this Pi session open.");
				}
			} catch {
				return finish("blocked", "Completion delivered; quit confirmation was interrupted. This Pi session remains open.");
			}
		}
		reasons = blockers(ctx, exit);
		if (reasons.length) return finish("blocked", `Completion delivered; exit blocked: ${reasons.join("; ")}`);
		pending = exit;
		if (quit === "auto") autoExitUsed = true;
		return finish("scheduled", "Completion delivered; graceful exit is scheduled after a clean final reply, subject to a final check for new work. No pane will be closed.");
	};
}
