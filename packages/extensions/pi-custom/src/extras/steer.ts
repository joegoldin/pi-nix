// Esc with messages queued: interrupt and send them now.
//
// pi's Esc during a run aborts it and moves every queued message back into the
// editor, joined with a blank line ahead of whatever draft was there, and then
// waits for you to press Enter. Here the queued part is sent as soon as the
// abort settles, and the draft stays in the editor: queued messages become an
// interruption with a steer, which is what typing them during the run meant.
//
// pi gives extensions no read of its queue, so this works from what pi's own
// Esc leaves behind. It acts only when that is unmistakable: the run ended
// aborted, and the editor holds exactly the restored queue in front of the
// draft that was there when Esc was pressed. Anything else leaves the editor
// as pi left it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

/** The queued text pi put in front of the draft, or undefined when the editor is not in that shape. */
export function restoredQueue(after: string, draft: string): string | undefined {
	if (!draft.trim()) return after.trim() ? after : undefined;
	const tail = `\n\n${draft}`;
	if (!after.endsWith(tail)) return undefined;
	const queued = after.slice(0, -tail.length);
	return queued.trim() ? queued : undefined;
}

interface MessageLike {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** pi records an Esc abort either as stopReason "aborted" or as an error saying so. */
export function wasAborted(last: MessageLike | undefined): boolean {
	return last?.stopReason === "aborted" || (last?.stopReason === "error" && /\baborted\b/i.test(last.errorMessage ?? ""));
}

export function registerSteerNow(pi: ExtensionAPI): void {
	let draft: string | undefined;
	let aborted = false;
	let unsubscribe: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		draft = undefined;
		if (!ctx.hasUI || typeof ctx.ui.onTerminalInput !== "function") return;
		// Observes, never consumes: pi's own Esc still does the aborting.
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, "escape") && !ctx.isIdle() && ctx.hasPendingMessages()) {
				draft = ctx.ui.getEditorText();
				aborted = false;
			}
			return undefined;
		});
	});

	pi.on("agent_end", (event) => {
		if (draft === undefined) return;
		const last = [...(event.messages as MessageLike[])].reverse().find((m) => m.role === "assistant");
		aborted = wasAborted(last);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const before = draft;
		const wasAborted = aborted;
		draft = undefined;
		aborted = false;
		if (before === undefined || !wasAborted) return;
		const queued = restoredQueue(ctx.ui.getEditorText(), before);
		if (queued === undefined) return;
		ctx.ui.setEditorText(before);
		pi.sendUserMessage(queued);
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		draft = undefined;
	});
}
