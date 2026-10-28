import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { clean, record, redact } from "./state.ts";

export const SUBAGENT_ACTIVITY = "pi-minimap:subagent-activity";

/** Observe lifecycle metadata, never child transcripts or private side-chat prompts. */
export function observeSubagents(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	changed: () => void,
): () => void {
	const owner = ctx.sessionManager.getSessionId();
	const ownerFile = ctx.sessionManager.getSessionFile();
	const runs = new Set<string>();
	const fingerprints = new Map<string, string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type !== "custom" ||
			entry.customType !== SUBAGENT_ACTIVITY ||
			!record(entry.data)
		)
			continue;
		if (
			entry.data.sessionId === owner &&
			typeof entry.data.ownerRunId === "string"
		)
			runs.add(entry.data.ownerRunId);
	}
	const text = (value: unknown, max = 100) =>
		typeof value === "string" ? clean(redact(value), max) : undefined;
	const save = (ownerRunId: string, run: Record<string, unknown>) => {
		if (ctx.sessionManager.getSessionId() !== owner) return;
		const key = String(run.runId);
		const fingerprint = JSON.stringify(run);
		if (fingerprints.get(key) === fingerprint) return;
		fingerprints.set(key, fingerprint);
		if (fingerprints.size > 200)
			fingerprints.delete(fingerprints.keys().next().value!);
		try {
			pi.appendEntry(SUBAGENT_ACTIVITY, {
				sessionId: owner,
				ownerRunId,
				runs: [run],
				at: Date.now(),
			});
			changed();
		} catch {
			fingerprints.delete(key);
			ctx.ui.notify("Minimap child activity could not be saved", "error");
		}
	};
	const offStart = pi.events.on("subagent:async-started", (event) => {
		if (
			!record(event) ||
			(event.sessionId !== owner &&
				(!ownerFile || event.sessionId !== ownerFile))
		)
			return;
		const id = text(event.id);
		if (!id) return;
		runs.add(id);
		save(id, { runId: id, agent: text(event.agent), status: "running" });
	});
	const offChild = pi.events.on("subagent:child-status", (event) => {
		if (
			!record(event) ||
			event.version !== 1 ||
			typeof event.runId !== "string" ||
			!runs.has(event.runId)
		)
			return;
		if (!["started", "stopping", "stopped"].includes(String(event.status)))
			return;
		const child = text(event.childRunId) ?? text(event.childId);
		if (!child) return;
		save(event.runId, {
			runId: child,
			parentRunId: text(event.runId),
			agent: text(event.agent),
			status: event.status === "started" ? "running" : event.status,
			taskInfo: text(event.label),
		});
	});
	return () => {
		offStart();
		offChild();
	};
}
