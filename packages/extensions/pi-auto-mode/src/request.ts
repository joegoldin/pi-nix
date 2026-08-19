// Translates pi's ToolCallEvent union into the flat {toolName, value} shape the
// rule matcher and the classifier both consume. Field names are taken from
// packages/coding-agent/src/core/tools/*.ts, verified against pi 0.84.2.

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { RuleTarget } from "./rules.ts";

export interface ToolRequest extends RuleTarget {
	toolCallId: string;
	/** Coarse category the classifier prompt groups by. */
	surface: string;
	input: Record<string, unknown>;
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
	return `{${entries.join(",")}}`;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

export function renderRequest(event: ToolCallEvent): ToolRequest {
	const toolName = event.toolName;
	const input = ((event as { input?: unknown }).input ?? {}) as Record<string, unknown>;
	const base = { toolName, toolCallId: event.toolCallId, input };

	switch (toolName) {
		case "bash":
			return { ...base, surface: "bash", value: str(input.command) ?? "" };
		case "read":
			return { ...base, surface: "read", value: str(input.path) ?? "" };
		case "write":
		case "edit":
			return { ...base, surface: "write", value: str(input.path) ?? "" };
		case "grep":
		case "find":
			return { ...base, surface: "read", value: str(input.path) ?? str(input.pattern) ?? "." };
		case "ls":
			return { ...base, surface: "read", value: str(input.path) ?? "." };
		default:
			return { ...base, surface: "tool", value: stableStringify(input) };
	}
}
