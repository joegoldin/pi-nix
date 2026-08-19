// argv construction and the tool-duration clock. Both pure, so the whole
// notification surface tests without spawning anything.

import type { NotifyConfig } from "./config.ts";

export type Urgency = "low" | "normal" | "critical";

export interface Notification {
	title: string;
	body: string;
	urgency: Urgency;
}

export function escapeAppleScript(value: string): string {
	// Backslashes first, or the escapes we add get re-escaped. Newlines end an
	// `osascript -e` statement, so they are folded to spaces rather than escaped.
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

export function notifierArgs(config: NotifyConfig, note: Notification): string[] {
	switch (config.style) {
		case "notify-send":
			return ["--app-name", config.appName, "--urgency", note.urgency, note.title, note.body];
		case "terminal-notifier":
			return ["-title", note.title, "-message", note.body, "-group", config.appName];
		case "osascript":
			return [
				"-e",
				`display notification "${escapeAppleScript(note.body)}" with title "${escapeAppleScript(note.title)}"`,
			];
	}
}

export interface ToolClock {
	start(toolCallId: string, toolName: string, at: number): void;
	end(toolCallId: string, at: number): { toolName: string; elapsedMs: number } | null;
}

export function createToolClock(): ToolClock {
	const running = new Map<string, { toolName: string; startedAt: number }>();
	return {
		start(toolCallId, toolName, at) {
			running.set(toolCallId, { toolName, startedAt: at });
		},
		end(toolCallId, at) {
			const entry = running.get(toolCallId);
			if (entry === undefined) return null;
			running.delete(toolCallId);
			return { toolName: entry.toolName, elapsedMs: Math.max(0, at - entry.startedAt) };
		},
	};
}

export function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

export function longToolNotification(
	finished: { toolName: string; elapsedMs: number },
	thresholdMs: number,
): Notification | null {
	if (finished.elapsedMs < thresholdMs) return null;
	return {
		title: "pi",
		body: `${finished.toolName} finished after ${formatDuration(finished.elapsedMs)}`,
		urgency: "low",
	};
}
