import { spawn } from "node:child_process";

/**
 * notify-send stays alive to service the default click action. Its first line
 * is the ID, not completion: waiting for exit would block Pi until dismissal
 * and prevent an answered permission prompt from closing its notification.
 */
export function sendLinuxNotification(command: string, args: string[]): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
		let output = "";
		let resolved = false;
		const finish = (value: string | null) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timeout);
			child.unref();
			if ("unref" in child.stdout && typeof child.stdout.unref === "function") child.stdout.unref();
			resolve(value);
		};
		const timeout = setTimeout(() => {
			child.kill();
			finish(null);
		}, 5000);
		timeout.unref();
		child.on("error", () => finish(null));
		child.on("close", () => finish(null));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (resolved) return;
			output += chunk;
			const newline = output.indexOf("\n");
			if (newline >= 0) {
				const id = output.slice(0, newline).trim();
				finish(/^\d+$/.test(id) ? id : null);
			}
		});
	}).catch(() => null);
}
