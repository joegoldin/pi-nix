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

/**
 * Group for notifications something will close later. Kept apart from the
 * default group so terminal-notifier's `-remove` cannot take an unrelated pi
 * notification down with the one it was aimed at.
 */
function dismissibleGroup(config: NotifyConfig): string {
	return `${config.appName}-ask`;
}

export function notifierArgs(config: NotifyConfig, note: Notification, dismissible = false): string[] {
	switch (config.style) {
		case "notify-send":
			return [
				"--app-name",
				config.appName,
				"--urgency",
				note.urgency,
				// The printed id is the only handle CloseNotification accepts, so it
				// has to be asked for at send time or the chance is gone.
				...(dismissible ? ["--print-id"] : []),
				note.title,
				note.body,
			];
		case "terminal-notifier":
			return [
				"-title",
				note.title,
				"-message",
				note.body,
				"-group",
				dismissible ? dismissibleGroup(config) : config.appName,
			];
		case "osascript":
			// Nothing to add: Notification Center exposes no way to name, let alone
			// close, a notification raised this way.
			return [
				"-e",
				`display notification "${escapeAppleScript(note.body)}" with title "${escapeAppleScript(note.title)}"`,
			];
	}
}

/** What a sent notification leaves behind so it can be closed again. */
export type NotificationHandle =
	| { style: "notify-send"; id: string }
	| { style: "terminal-notifier"; group: string };

/**
 * Reads the handle out of the send command's stdout. Null means there is
 * nothing to close later, either because the style has no dismissal path or
 * because notify-send printed no id, and an untracked notification is better
 * than a close call aimed at a guess.
 */
export function notificationHandle(config: NotifyConfig, stdout: string): NotificationHandle | null {
	switch (config.style) {
		case "notify-send": {
			const id = stdout.trim();
			return /^\d+$/.test(id) ? { style: "notify-send", id } : null;
		}
		case "terminal-notifier":
			return { style: "terminal-notifier", group: dismissibleGroup(config) };
		case "osascript":
			return null;
	}
}

/**
 * The command that closes a live notification, or null when this config offers
 * no way to close one. notify-send's CloseNotification lives on D-Bus and has
 * no CLI of its own, so without a client path the notification is left to time
 * out, which is the same silent degradation a failed send already gets.
 */
export function dismissCommand(
	config: NotifyConfig,
	handle: NotificationHandle,
): { command: string; args: string[] } | null {
	switch (handle.style) {
		case "notify-send":
			if (config.dismisser === "") return null;
			return {
				command: config.dismisser,
				args: [
					"call",
					"--session",
					"--dest",
					"org.freedesktop.Notifications",
					"--object-path",
					"/org/freedesktop/Notifications",
					"--method",
					"org.freedesktop.Notifications.CloseNotification",
					handle.id,
				],
			};
		case "terminal-notifier":
			return { command: config.notifier, args: ["-remove", handle.group] };
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
