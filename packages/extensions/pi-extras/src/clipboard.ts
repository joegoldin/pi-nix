// Copying to the system clipboard.
//
// pi has no clipboard API, so this shells out. The chain is Wayland first, then
// X11, then macOS, and a host with none of them simply loses the copy and cut
// chords: an absent clipboard tool is an ordinary state on a server, not an
// error worth interrupting a session for.
//
// PI_EXTRAS_CLIPBOARD overrides the whole chain with one absolute path, because
// inside the jail nothing is on PATH unless a permission put it there.

import { spawn } from "node:child_process";

export interface ClipboardTarget {
	command: string;
	args: string[];
}

/** Runs one target, resolving false when it is missing or fails. */
export type ClipboardRunner = (target: ClipboardTarget, text: string) => Promise<boolean>;

/** xclip writes to the PRIMARY selection unless told otherwise; the others
 *  already write to the clipboard. */
function argsFor(command: string): string[] {
	return command.split("/").pop() === "xclip" ? ["-selection", "clipboard"] : [];
}

export function clipboardTargets(env: Record<string, string | undefined>): ClipboardTarget[] {
	const override = env.PI_EXTRAS_CLIPBOARD;
	if (override) return [{ command: override, args: argsFor(override) }];
	return ["wl-copy", "xclip", "pbcopy"].map((command) => ({ command, args: argsFor(command) }));
}

export async function copyToClipboard(text: string, targets: ClipboardTarget[], run: ClipboardRunner): Promise<boolean> {
	for (const target of targets) {
		try {
			if (await run(target, text)) return true;
		} catch {
			// A missing binary throws on spawn. Try the next one.
		}
	}
	return false;
}

/** The real runner: write the text to the tool's stdin and wait for exit 0. */
export const spawnRunner: ClipboardRunner = (target, text) =>
	new Promise<boolean>((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(target.command, target.args, { stdio: ["pipe", "ignore", "ignore"] });
		} catch {
			resolve(false);
			return;
		}
		child.on("error", () => {
			resolve(false);
		});
		child.on("close", (code) => {
			resolve(code === 0);
		});
		child.stdin?.on("error", () => {
			// The tool exited before reading; close reports the outcome.
		});
		child.stdin?.end(text);
	});
