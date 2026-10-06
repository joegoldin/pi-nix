// The summary line after a run, so the end of a long one is visible when you
// come back to it: how long it took, when it finished, and how many
// background shells are still going.
//
// Written once pi has settled rather than at agent_end: a message sent while
// the run is still winding down is a steer, and a steer can start another
// turn. It is a custom message so it sits in the transcript where the run
// ended, and the context hook takes it back out of every request, so the
// model never pays for it or reads it as something said to it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { UiConfig } from "../ui/config.ts";
import { type RunSummary, summaryText } from "./turn-text.ts";

const TYPE = "pi-custom-run-summary";

interface MessageLike {
	role?: string;
	customType?: string;
	stopReason?: string;
}

export function registerRunSummary(pi: ExtensionAPI, config: () => UiConfig, runningShells: () => number): void {
	let startedAt: number | undefined;
	let pending: Omit<RunSummary, "shells"> | undefined;

	pi.on("agent_start", () => {
		startedAt = Date.now();
		pending = undefined;
	});

	pi.on("agent_end", (event, ctx) => {
		const began = startedAt;
		startedAt = undefined;
		if (began === undefined || !ctx.hasUI) return;
		const last = [...(event.messages as MessageLike[])].reverse().find((m) => m.role === "assistant");
		// An interrupted run was ended by you, at the keyboard; it needs no reminder.
		if (last?.stopReason === "aborted") return;
		const settings = config();
		const doneAt = Date.now();
		if (!settings.turnSummary || doneAt - began < settings.turnSummaryMinSeconds * 1000) return;
		pending = { elapsedMs: doneAt - began, doneAt, failed: last?.stopReason === "error" };
	});

	pi.on("agent_settled", () => {
		const summary = pending;
		pending = undefined;
		if (!summary) return;
		const full = { ...summary, shells: runningShells() };
		pi.sendMessage({ customType: TYPE, content: summaryText(full), display: true, details: full }, { triggerTurn: false });
	});

	pi.on("context", (event) => ({
		messages: (event.messages as MessageLike[]).filter((m) => !(m.role === "custom" && m.customType === TYPE)) as typeof event.messages,
	}));

	pi.registerMessageRenderer(TYPE, (message, _options, theme) => {
		const details = message.details as RunSummary | undefined;
		const text = details ? summaryText(details) : String(message.content);
		const [mark, ...rest] = text.split(" ");
		const markColour = details?.failed ? "error" : "success";
		return { render: () => [`${theme.fg(markColour as never, mark ?? "")} ${theme.fg("dim", rest.join(" "))}`], invalidate() {} };
	});
}
