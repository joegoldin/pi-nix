// Recent user turns for the classifier. Design §9: soft_deny is cleared by
// explicit user intent, so the classifier must be shown what the user actually
// asked for. Reading the session must never break a tool call, so every failure
// degrades to "no turns" — which makes the classifier strictly more cautious,
// not less.

/** The slice of ReadonlySessionManager this module needs. */
export interface TurnSource {
	getBranch(fromId?: string): unknown[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => {
			return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
		})
		.map((block) => block.text)
		.join("");
}

export function recentUserTurns(sessionManager: TurnSource, limit: number): string[] {
	if (!Number.isFinite(limit) || limit <= 0) return [];

	let entries: unknown[];
	try {
		entries = sessionManager.getBranch();
	} catch {
		return [];
	}

	const turns: string[] = [];
	for (const entry of entries) {
		const e = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
		if (e.type !== "message") continue;
		if (e.message?.role !== "user") continue;
		const text = textOf(e.message.content).trim();
		if (text !== "") turns.push(text);
	}

	return turns.slice(-limit);
}
