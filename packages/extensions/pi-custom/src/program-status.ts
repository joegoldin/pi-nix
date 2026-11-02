import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ActivityStatus {
	state: "idle" | "working" | "blocked" | "done" | "error";
	kind?: "permission" | "question" | "auth";
	title?: string;
	message?: string;
	progress?: number;
}

/** Keep opaque/session ids within the protocol's 32-byte segment limit. */
export function activityKey(group: string, id: string): string {
	return `${group}/${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

/** Optional on older/RPC hosts; reporting must never change a tool's outcome. */
export function reportActivity(ctx: Pick<ExtensionContext, "ui" | "hasUI"> | undefined, key: string, status: ActivityStatus | undefined): void {
	if (!ctx || ctx.hasUI === false) return;
	try {
		(ctx.ui as { setProgramStatus?(key: string, status: ActivityStatus | undefined): void }).setProgramStatus?.(key, status);
	} catch {}
}
