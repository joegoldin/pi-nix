import { expect, it } from "bun:test";
import { sendLinuxNotification } from "./send.ts";

it("returns the notification ID while the click listener is still running", async () => {
	const id = await sendLinuxNotification(process.execPath, ["-e", "process.stdout.write(`${process.pid}\\n`); setInterval(() => {}, 1000)"]);
	expect(id).toMatch(/^\d+$/);
	try {
		expect(process.kill(Number(id), 0)).toBe(true);
	} finally {
		process.kill(Number(id));
	}
});

it("silently handles a missing notifier and a notifier that exits without an ID", async () => {
	expect(await sendLinuxNotification("/no-such-pi-notifier", [])).toBeNull();
	expect(await sendLinuxNotification(process.execPath, ["-e", "process.exit(1)"])).toBeNull();
});

it("does not mistake an action name for a notification ID", async () => {
	expect(await sendLinuxNotification(process.execPath, ["-e", "console.log('default')"])).toBeNull();
});
