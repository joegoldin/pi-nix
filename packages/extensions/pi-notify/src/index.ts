// Desktop notifications for blocking dialogs, completed turns and long tools.
// Native ui_prompt_start/end covers questions without coupling to their tools.
// Permission broadcasts retain the named decision notification.
// Design §10's original triggers:
//
//   Claude's `Notification` hook  -> a permission prompt raised, observed on the
//                                    event bus rather than by coupling to whoever
//                                    raised it
//   Claude's `Stop` hook          -> agent_settled
//   Claude's `PreToolUse:Bash`    -> tool_execution_start/end past a threshold

import { readFileSync } from "node:fs";
import type { NotifyConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import {
	createToolClock,
	dismissCommand,
	longToolNotification,
	type Notification,
	type NotificationHandle,
	notificationHandle,
	notifierArgs,
} from "./notifier.ts";

/** @gotgenes/pi-permission-system's PERMISSIONS_UI_PROMPT_CHANNEL. */
export const PERMISSIONS_UI_PROMPT_CHANNEL = "permissions:ui_prompt";
/**
 * @gotgenes/pi-permission-system's PERMISSIONS_DECISION_CHANNEL, emitted after
 * every gate resolution and carrying the same `requestId` the UI prompt did.
 * It is the only signal on the bus that says an ask stopped waiting.
 */
export const PERMISSIONS_DECISION_CHANNEL = "permissions:decision";

export interface NotifyHost {
	on(event: string, handler: (event: never, ctx?: never) => unknown): void;
	events: { on(channel: string, handler: (data: unknown) => void): () => void };
	exec(command: string, args: string[]): Promise<unknown>;
}

export function registerHandlers(pi: NotifyHost, config: NotifyConfig, now: () => number = Date.now): void {
	if (!config.enabled || config.notifier === "") return;

	// Null distinguishes "the command failed" from "it ran and said nothing",
	// which is what tells the caller whether there is a live notification to
	// remember. Failure is silent by design: a notification must never break a
	// session, and neither must the attempt to take one down again.
	const run = async (command: string, args: string[]): Promise<string | null> => {
		try {
			const result = (await pi.exec(command, args)) as { stdout?: unknown } | undefined;
			return typeof result?.stdout === "string" ? result.stdout : "";
		} catch {
			return null;
		}
	};

	const send = async (note: Notification, dismissible = false): Promise<string | null> =>
		run(config.notifier, notifierArgs(config, note, dismissible));

	if (config.events.agentSettled) {
		pi.on("agent_settled", async () => {
			await send({ title: config.appName, body: "Ready for input", urgency: "normal" });
		});
	}

	if (config.events.permissionPrompt) {
		// Keyed by requestId, which is what ties a decision back to the prompt that
		// raised it. A tool call runs several gates and so raises several requests;
		// only the ones that reached the UI are in here, so a decision that never
		// prompted finds nothing and does nothing.
		const live = new Map<string, Promise<NotificationHandle | null>>();
		const permissionsWaiting = new Set<string>();
		let promptSequence = 0;
		let nativePrompt: string | undefined;

		const onPrompt = (data: unknown, userInput = false) => {
			const d = (data ?? {}) as Record<string, unknown>;
			// PermissionUiPromptEvent carries `surface` ("bash", "skill", "read"),
			// never `toolName`, so reading toolName alone made every one of these
			// say "a tool call" and named nothing. toolName is still consulted
			// second because the auto-mode prompt channel is declared with that
			// shape, and the generic phrase is the honest answer when a prompt
			// identifies nothing at all.
			const named = [d.surface, d.toolName].find(
				(v) => typeof v === "string" && v !== "",
			);
			const tool = typeof named === "string" ? named : "a tool call";
			const requestId = typeof d.requestId === "string" && d.requestId !== "" ? d.requestId : null;
			// Tracking an ask that carries no requestId would leak a handle that
			// nothing can ever match, so those notifications are fire and forget.
			const dismissible = config.dismissOnResolve && requestId !== null;
			const pending = (async () => {
				const stdout = await send(
					{ title: config.appName, body: userInput ? "Needs your input" : `Needs your decision on ${tool}`, urgency: "critical" },
					dismissible,
				);
				return stdout === null ? null : notificationHandle(config, stdout);
			})();
			if (dismissible && requestId !== null) {
				live.set(requestId, pending);
				void pending.then((handle) => {
					if (handle === null && live.get(requestId) === pending) live.delete(requestId);
				});
			}
		};
		pi.events.on(PERMISSIONS_UI_PROMPT_CHANNEL, (data) => {
			const d = (data ?? {}) as Record<string, unknown>;
			if (typeof d.requestId === "string") permissionsWaiting.add(d.requestId);
			onPrompt(data);
		});
		pi.on("ui_prompt_start", () => {
			// Permission requests broadcast before opening Pi's dialog. Keep their
			// named notification rather than also showing a generic one.
			if (permissionsWaiting.size > 0) return;
			nativePrompt = `pi-ui:${++promptSequence}`;
			onPrompt({ requestId: nativePrompt }, true);
		});

		const onResolved = (data: unknown) => {
			const d = (data ?? {}) as Record<string, unknown>;
			if (typeof d.requestId !== "string") return;
			permissionsWaiting.delete(d.requestId);
			const handle = live.get(d.requestId);
			if (handle === undefined) return;
			// Dropped before the close runs, so a repeated decision on the same
			// request cannot fire a second close at an id already reused.
			live.delete(d.requestId);
			// An answer can arrive before the desktop service returns its ID.
			void handle.then((resolved) => {
				if (resolved === null) return;
				const command = dismissCommand(config, resolved);
				if (command !== null) void run(command.command, command.args);
			});
		};
		pi.events.on(PERMISSIONS_DECISION_CHANNEL, onResolved);
		pi.on("ui_prompt_end", () => {
			if (nativePrompt === undefined) return;
			onResolved({ requestId: nativePrompt });
			nativePrompt = undefined;
		});
	}

	if (config.events.longToolCall) {
		const clock = createToolClock();
		pi.on("tool_execution_start", async (event: never) => {
			const e = event as unknown as { toolCallId?: string; toolName?: string };
			if (typeof e.toolCallId === "string") clock.start(e.toolCallId, e.toolName ?? "tool", now());
		});
		pi.on("tool_execution_end", async (event: never) => {
			const e = event as unknown as { toolCallId?: string };
			if (typeof e.toolCallId !== "string") return;
			const finished = clock.end(e.toolCallId, now());
			if (finished === null) return;
			const note = longToolNotification(finished, config.longToolCallThresholdMs);
			if (note !== null) await send({ ...note, title: config.appName });
		});
	}
}

export default function (pi: NotifyHost) {
	registerHandlers(pi, loadConfig((path) => readFileSync(path, "utf8"), process.env));
}
