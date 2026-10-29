import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Report the wait, never the private command or the authorization decision. */
export function beginPermissionStatus(ui: Pick<ExtensionUIContext, "setProgramStatus">): () => void {
	const key = `permissions/${randomUUID().replaceAll("-", "")}`;
	try { ui.setProgramStatus?.(key, { state: "blocked", kind: "permission", title: "Approval", message: "Waiting for your permission" }); } catch {}
	return () => { try { ui.setProgramStatus?.(key, undefined); } catch {} };
}
