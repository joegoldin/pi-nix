import { isAbsolute } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const REQUIRED_CHILD_EXTENSIONS = Symbol.for(
	"pi-subagents.required-child-extensions.v1",
);

/** Honor the same mandatory permission extensions as managed subagents. */
export function requiredSideExtensions(
	owner: string,
	root: Record<symbol, unknown> = globalThis as unknown as Record<
		symbol,
		unknown
	>,
	requirePermission = false,
): string[] {
	const store = root[REQUIRED_CHILD_EXTENSIONS];
	if (store === undefined && !requirePermission) return [];
	if (
		!store ||
		typeof store !== "object" ||
		!("version" in store) ||
		store.version !== 1 ||
		!("bySession" in store) ||
		!(store.bySession instanceof Map)
	)
		throw new Error(
			"Cannot start a side conversation: invalid required-child extension registry.",
		);
	const entries: unknown = store.bySession.get(owner) ?? [];
	if (!Array.isArray(entries))
		throw new Error("Invalid side-conversation permission extensions.");
	if (
		requirePermission &&
		!entries.some(
			(entry) =>
				entry &&
				entry.id === "pi-permissions" &&
				entry.requireForAllRunners === true,
		)
	)
		throw new Error("Editing requires the parent's child permission gates.");
	return [
		...new Set(
			entries.map((entry: unknown) => {
				if (
					!entry ||
					typeof entry !== "object" ||
					!("id" in entry) ||
					typeof entry.id !== "string" ||
					!("path" in entry) ||
					typeof entry.path !== "string" ||
					!isAbsolute(entry.path) ||
					entry.path.includes("\0")
				)
					throw new Error("Invalid required side-conversation extension path.");
				return entry.path;
			}),
		),
	];
}

/** Branch a separate manager so neither the parent's leaf nor its file changes. */
export function forkSideSession(
	parent: Pick<SessionManager, "getSessionFile" | "getLeafId" | "getBranch">,
	cwd: string,
	directory: string,
): SessionManager {
	const leaf = parent.getLeafId();
	if (!leaf) return SessionManager.create(cwd, directory);
	const file = parent.getSessionFile();
	if (!file)
		throw new Error(
			"Forking a side conversation requires a saved parent session.",
		);
	const child = SessionManager.open(file, directory, cwd);
	child.createBranchedSession(leaf);
	// A fork can happen while the main agent is inside a tool. Close only the
	// child's missing pairs, without claiming that it ran or completed those tools.
	const pending = new Map<string, string>();
	for (const message of child.buildSessionContext().messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") pending.set(block.id, block.name);
			}
		} else if (message.role === "toolResult")
			pending.delete(message.toolCallId);
	}
	for (const [toolCallId, toolName] of pending) {
		child.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			isError: true,
			timestamp: Date.now(),
			content: [
				{
					type: "text",
					text: "Parent tool was pending at the fork; not executed by this side conversation. Its result is not available here.",
				},
			],
		});
	}
	return child;
}
