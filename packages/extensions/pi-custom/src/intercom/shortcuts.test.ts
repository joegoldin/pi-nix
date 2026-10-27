import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import intercom from "./index.ts";

test("Intercom retains its command and uses Alt+j, not minimap's Alt+m", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-intercom-keys-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const shortcuts = new Map<string, any>();
	const commands = new Map<string, any>();
	try {
		mkdirSync(join(dir, "intercom"));
		writeFileSync(join(dir, "intercom/config.json"), "{}");
		process.env.PI_CODING_AGENT_DIR = dir;
		intercom({
			on() {}, registerTool() {}, registerMessageRenderer() {},
			registerShortcut: (key: string, spec: any) => shortcuts.set(key, spec),
			registerCommand: (name: string, spec: any) => commands.set(name, spec),
		} as any);
		expect(shortcuts.get("alt+j")?.description).toBe("Message another session");
		expect(shortcuts.has("alt+m")).toBe(false);
		expect(commands.has("intercom")).toBe(true);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
