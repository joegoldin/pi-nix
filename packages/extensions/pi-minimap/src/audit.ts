import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CALL_TYPE, record, redact, type Usage } from "./state.ts";
import type { ReportedUsage } from "./engine.ts";

export interface AuditEvent {
	version: 1;
	id: string;
	sessionId: string;
	phase:
		| "request"
		| "started"
		| "response"
		| "error"
		| "applied"
		| "discarded"
		| "invalid"
		| "accounting";
	at: number;
	model?: string;
	parameters?: { maxTokens: number; sessionId: string; reasoning?: "low" };
	prompt?: string;
	systemPrompt?: string;
	text?: string;
	stopReason?: string;
	error?: string;
	sourceId?: string | null;
	stateEntryId?: string | null;
	reportedUsage?: ReportedUsage;
	usage?: Usage;
	pricing?: unknown;
}
export type AuditInput = Omit<AuditEvent, "version" | "sessionId">;
interface SessionIdentity {
	getSessionId(): string;
	getSessionFile?(): string | undefined;
}
export type AuditWriter = (event: AuditInput) => void;

function redactPayload(text: string): string {
	// Decode JSON strings before redacting: escaped quote delimiters otherwise
	// hide credentials embedded in summary text from the plain-text matcher.
	const scrub = (value: unknown): unknown => {
		if (typeof value === "string") return redact(value);
		if (Array.isArray(value)) return value.map(scrub);
		if (record(value))
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					/(?:^|[_-])(?:api[_-]?key|private[_-]?key|password|secret|(?:access[_-]?)?token)$/i.test(
						key,
					)
						? "[redacted]"
						: scrub(item),
				]),
			);
		return value;
	};
	try {
		const parsed: unknown = JSON.parse(text);
		const safe = JSON.stringify(scrub(parsed));
		if (safe !== JSON.stringify(parsed)) return safe;
	} catch {
		/* Non-JSON responses are retained as redacted text too. */
	}
	return redact(text);
}

export function createAuditWriter(
	owner: SessionIdentity,
	current: () => SessionIdentity | undefined,
	append: (type: string, data: AuditEvent) => void,
): AuditWriter {
	const sessionId = owner.getSessionId();
	const file = owner.getSessionFile?.();
	return (event) => {
		const data: AuditEvent = { ...event, version: 1, sessionId };
		for (const field of ["prompt", "systemPrompt", "text", "error"] as const) {
			if (typeof data[field] === "string")
				data[field] = redactPayload(data[field]!);
		}
		if (current()?.getSessionId() === sessionId) {
			append(CALL_TYPE, data);
			return;
		}
		// SessionManager is reused on /new and forks. A late response belongs
		// to its original file, never to the session that replaced it.
		if (!file) return; // Non-persisting sessions have no retired file to reopen.
		if (!existsSync(file))
			throw new Error("Original minimap session file is gone");
		const original = SessionManager.open(file);
		if (original.getSessionId() !== sessionId)
			throw new Error("Original minimap session file changed");
		original.appendCustomEntry(CALL_TYPE, data);
	};
}

export function readCalls(
	entries: unknown[],
): Array<{ id: string; sessionId: string; events: AuditEvent[] }> {
	const calls = new Map<
		string,
		{ id: string; sessionId: string; events: AuditEvent[] }
	>();
	for (const entry of entries) {
		if (
			!record(entry) ||
			entry.type !== "custom" ||
			entry.customType !== CALL_TYPE ||
			!record(entry.data)
		)
			continue;
		const event = entry.data;
		if (
			event.version !== 1 ||
			typeof event.id !== "string" ||
			typeof event.sessionId !== "string" ||
			typeof event.phase !== "string" ||
			![
				"request",
				"started",
				"response",
				"error",
				"applied",
				"discarded",
				"invalid",
				"accounting",
			].includes(event.phase) ||
			typeof event.at !== "number" ||
			!Number.isFinite(event.at) ||
			!Number.isFinite(new Date(event.at).getTime())
		)
			continue;
		const key = `${event.sessionId}:${event.id}`;
		let call = calls.get(key);
		if (!call) {
			call = { id: event.id, sessionId: event.sessionId, events: [] };
			calls.set(key, call);
		}
		call.events.push(event as unknown as AuditEvent);
	}
	return [...calls.values()];
}
