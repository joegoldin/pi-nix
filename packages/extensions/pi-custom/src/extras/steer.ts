// Native queue controls own submission and display. This hook only preserves
// /goal when Escape restores queued guidance instead of cancelling the goal.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export const STEERING = Symbol.for("pi-custom.steering");

function steering(on: boolean): void {
	(globalThis as Record<symbol, unknown>)[STEERING] = on;
}

export function registerSteeringGuard(pi: ExtensionAPI): void {
	let unsubscribe: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		steering(false);
		if (!ctx.hasUI || typeof ctx.ui.onTerminalInput !== "function") return;
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, "escape")) steering(!ctx.isIdle() && ctx.hasPendingMessages());
			return undefined;
		});
	});
	pi.on("agent_settled", () => steering(false));
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		steering(false);
	});
}
