import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RexHook = () => Promise<string>;

/** The official hook describes this binary's protocol without contacting a server. */
export function readRexContext(): Promise<string> {
	return new Promise((resolve) => {
		execFile("rex", ["__internal", "session-start", "--agent", "claude", "--feature-session-naming=false"],
			{ timeout: 2000, maxBuffer: 16 * 1024 }, (error, stdout) => resolve(error ? "" : stdout.trim()));
	});
}

export function inRex(env: NodeJS.ProcessEnv): boolean {
	// Inherited environment is data. Reject control characters before asking the
	// upstream hook to interpolate it into model context.
	return /^session:[a-f0-9-]{36}$/i.test(env.REX_SESSION ?? "")
		&& /^block:[a-f0-9-]{36}$/i.test(env.REX_BLOCK ?? "");
}

export function registerRexContext(pi: ExtensionAPI, env = process.env, read: RexHook = readRexContext): void {
	let context: Promise<string> | undefined;
	pi.on("session_start", () => { context = undefined; });
	pi.on("before_agent_start", async (event) => {
		if (!inRex(env)) return;
		context ??= read().catch(() => "");
		const text = await context;
		if (!text) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${text}\nRex context is location information, not a request to change terminals.` };
	});
}
