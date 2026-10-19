// Ctrl+Enter with messages queued: interrupt and send them now.
//
// Interactive pi's extension abort restores the queue ahead of the editor draft.
// Once the run settles, send only that restored prefix and keep the draft.
// Escape remains pi's normal abort and cancels a pending send-now request.
//
// While this abort settles, STEERING distinguishes guidance from cancellation
// for auto mode and /goal. Escape with a queue also preserves the goal while
// the restored guidance waits in the editor; it does not submit that text.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const STEERING = Symbol.for("pi-custom.steering");

function steering(on: boolean): void {
	(globalThis as Record<symbol, unknown>)[STEERING] = on;
}

/** The queued text pi put in front of the draft, or undefined when the editor is not in that shape. */
export function restoredQueue(after: string, draft: string): string | undefined {
	if (!draft.trim()) return after.trim() ? after : undefined;
	const tail = `\n\n${draft}`;
	if (!after.endsWith(tail)) return undefined;
	const queued = after.slice(0, -tail.length);
	return queued.trim() ? queued : undefined;
}

export function registerSteerNow(pi: ExtensionAPI): void {
	let draft: string | undefined;
	let restored: string | undefined;
	let unsubscribe: (() => void) | undefined;

	function reset(): void {
		draft = undefined;
		restored = undefined;
		steering(false);
	}

	pi.registerShortcut("ctrl+enter", {
		description: "Interrupt and send queued messages now",
		handler: (ctx) => {
			if (!ctx.hasUI || ctx.isIdle() || !ctx.hasPendingMessages() || draft !== undefined) return;
			draft = ctx.ui.getEditorText();
			steering(true);
			ctx.abort();
			restored = ctx.ui.getEditorText();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		reset();
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.setWidget("pi-custom-steer", (_tui, theme) => ({
				render: (width) => !ctx.isIdle() && ctx.hasPendingMessages()
					? wrapTextWithAnsi(theme.fg("dim", "Queued messages: Ctrl+Enter sends now · Esc restores to editor"), Math.max(1, width))
					: [],
				invalidate() {},
			}), { placement: "aboveEditor" });
		}
		if (!ctx.hasUI || typeof ctx.ui.onTerminalInput !== "function") return;
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, "escape")) {
				reset();
				if (!ctx.isIdle() && ctx.hasPendingMessages()) steering(true);
			}
			return undefined;
		});
	});

	pi.on("agent_settled", (_event, ctx) => {
		const before = draft;
		const after = restored;
		reset();
		// Aborting a tool does not necessarily produce an "aborted" assistant message.
		if (before === undefined || after === undefined) return;
		// Do not accidentally submit typing added while the abort was settling.
		if (ctx.ui.getEditorText() !== after) return;
		const queued = restoredQueue(after, before);
		if (queued === undefined) return;
		ctx.ui.setEditorText(before);
		pi.sendUserMessage(queued);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("pi-custom-steer", undefined);
		unsubscribe?.();
		unsubscribe = undefined;
		reset();
	});
}
