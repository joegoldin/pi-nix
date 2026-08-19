// pi-notify entrypoint. Design §10's three triggers:
//
//   Claude's `Notification` hook  -> a permission prompt raised, observed on the
//                                    event bus rather than by coupling to whoever
//                                    raised it
//   Claude's `Stop` hook          -> agent_settled
//   Claude's `PreToolUse:Bash`    -> tool_execution_start/end past a threshold

import { readFileSync } from "node:fs";
import type { NotifyConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { createToolClock, longToolNotification, type Notification, notifierArgs } from "./notifier.ts";

/** pi-auto-mode's channel; see packages/extensions/pi-auto-mode/src/config.ts. */
export const AUTO_MODE_PROMPT_CHANNEL = "pi-auto-mode:prompt";
/** @gotgenes/pi-permission-system's PERMISSIONS_UI_PROMPT_CHANNEL. */
export const PERMISSIONS_UI_PROMPT_CHANNEL = "permissions:ui_prompt";

export interface NotifyHost {
	on(event: string, handler: (event: never, ctx?: never) => unknown): void;
	events: { on(channel: string, handler: (data: unknown) => void): () => void };
	exec(command: string, args: string[]): Promise<unknown>;
}

export function registerHandlers(pi: NotifyHost, config: NotifyConfig, now: () => number = Date.now): void {
	if (!config.enabled || config.notifier === "") return;

	const send = async (note: Notification): Promise<void> => {
		try {
			await pi.exec(config.notifier, notifierArgs(config, note));
		} catch {
			// A notification must never break a session. Failure is silent by design.
		}
	};

	if (config.events.agentSettled) {
		pi.on("agent_settled", async () => {
			await send({ title: config.appName, body: "Ready for input", urgency: "normal" });
		});
	}

	if (config.events.permissionPrompt) {
		const onPrompt = (data: unknown) => {
			const d = (data ?? {}) as Record<string, unknown>;
			const tool = typeof d.toolName === "string" && d.toolName !== "" ? d.toolName : "a tool call";
			void send({ title: config.appName, body: `Needs your decision on ${tool}`, urgency: "critical" });
		};
		pi.events.on(AUTO_MODE_PROMPT_CHANNEL, onPrompt);
		pi.events.on(PERMISSIONS_UI_PROMPT_CHANNEL, onPrompt);
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
