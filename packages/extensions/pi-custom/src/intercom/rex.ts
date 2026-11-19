import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRecord } from "./broker/protocol.ts";
import { type RexLocation, rexId } from "./broker/types.ts";

const exec = promisify(execFile);

/** Inherited IDs are useful even without the CLI; enrich only on a matching lookup. */
export async function readRexLocation(env = process.env): Promise<RexLocation | undefined> {
	const sessionId = env.REX_SESSION?.trim();
	const blockId = env.REX_BLOCK?.trim();
	if (!rexId(sessionId, "session") || !rexId(blockId, "block")) return undefined;
	const inherited = { sessionId, blockId };
	try {
		const { stdout } = await exec("rex", ["--autostart=false", "--timeout=1s", "whoami", "--json"], {
			env, timeout: 1500, maxBuffer: 16 * 1024,
		});
		const info: unknown = JSON.parse(stdout);
		if (isRecord(info) && info.session_id === sessionId && info.block_id === blockId) {
			return {
				...inherited,
				...(rexId(info.window_id, "window") ? { windowId: info.window_id } : {}),
				...(rexId(info.host_id) ? { hostId: info.host_id } : {}),
			};
		}
	} catch {
		// A missing CLI or unreachable server must not prevent messaging.
	}
	return inherited;
}

export function formatRexLocation({ sessionId, blockId, windowId, hostId }: RexLocation): string {
	return `Rex: ${[sessionId, windowId, blockId, hostId && `host:${hostId}`].filter(Boolean).join(" · ")}`;
}
