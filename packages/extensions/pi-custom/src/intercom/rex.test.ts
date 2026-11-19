import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRexLocation } from "./rex.ts";

const id = "01234567-8901-2345-6789-012345678901";
const sessionId = `session:${id}`;
const blockId = `block:${id}`;
const windowId = `window:${id}`;

async function withRex(result: object, check: (env: NodeJS.ProcessEnv) => Promise<void>) {
	const dir = mkdtempSync("/tmp/pi-rex-");
	try {
		writeFileSync(join(dir, "rex"), `#!/bin/sh\n[ "$*" = '--autostart=false --timeout=1s whoami --json' ] || exit 1\nprintf '%s\\n' '${JSON.stringify(result)}'\n`, { mode: 0o700 });
		await check({ PATH: dir, REX_SESSION: sessionId, REX_BLOCK: blockId });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("Rex location discovery", () => {
	it("uses only location IDs from a matching CLI result", async () => {
		await withRex({ session_id: sessionId, block_id: blockId, window_id: windowId, host_id: id, endpoint: "private-endpoint" }, async (env) => {
			expect(await readRexLocation(env)).toEqual({ sessionId, blockId, windowId, hostId: id });
		});
	});

	it("does not associate a different pane or host with inherited IDs", async () => {
		await withRex({ session_id: sessionId, block_id: "block:other", window_id: windowId, host_id: id }, async (env) => {
			expect(await readRexLocation(env)).toEqual({ sessionId, blockId });
		});
	});

	it("works without the CLI and omits missing or malformed locations", async () => {
		expect(await readRexLocation({ PATH: "/nonexistent", REX_SESSION: sessionId, REX_BLOCK: blockId })).toEqual({ sessionId, blockId });
		expect(await readRexLocation({ PATH: "/nonexistent", REX_SESSION: sessionId })).toBeUndefined();
		expect(await readRexLocation({ PATH: "/nonexistent", REX_SESSION: sessionId, REX_BLOCK: "block:bogus" })).toBeUndefined();
	});
});
