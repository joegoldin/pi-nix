// The only place that turns a judgement into a ToolCallEventResult, so the
// fail-closed policy of design §9 lives in exactly one function.

import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AutoModeConfig, AutoModePromptEvent } from "./config.ts";
import type { ClassifierVerdict } from "./classifier.ts";
import type { ToolRequest } from "./request.ts";
import { evaluateDeterministic } from "./rules.ts";

export interface GateContext {
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
}

export interface GateDeps {
	config: AutoModeConfig;
	classify(request: ToolRequest, userTurns: string[]): Promise<ClassifierVerdict>;
	userTurns(): string[];
	onPrompt(event: AutoModePromptEvent): void;
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function failClosed(
	deps: GateDeps,
	ctx: GateContext,
	request: ToolRequest,
	detail: string,
): Promise<ToolCallEventResult | undefined> {
	deps.onPrompt({ toolName: request.toolName, toolCallId: request.toolCallId, value: request.value, detail });

	if (!ctx.hasUI) {
		return { block: true, reason: `auto-mode failed closed (${detail}); no UI to ask, so the call is blocked` };
	}

	let approved: boolean;
	try {
		approved = await ctx.ui.confirm(
			"Auto-mode could not classify this call",
			`${detail}\n\nAllow ${request.toolName}: ${truncate(request.value, 300)}?`,
		);
	} catch (error) {
		return { block: true, reason: `auto-mode failed closed (${detail}); the prompt failed: ${messageOf(error)}` };
	}

	return approved ? undefined : { block: true, reason: "denied by the operator at the auto-mode fallback prompt" };
}

/** Returns undefined to let the call proceed, or a blocking ToolCallEventResult. */
export async function decide(
	deps: GateDeps,
	ctx: GateContext,
	request: ToolRequest,
): Promise<ToolCallEventResult | undefined> {
	if (!deps.config.enabled) return undefined;

	const deterministic = evaluateDeterministic(deps.config.deterministic, request);
	if (deterministic.state === "allow") return undefined;
	if (deterministic.state === "deny") {
		return { block: true, reason: `blocked by rule ${deterministic.matchedRule}` };
	}

	let verdict: ClassifierVerdict;
	try {
		verdict = await deps.classify(request, deps.userTurns());
	} catch (error) {
		return failClosed(deps, ctx, request, messageOf(error));
	}

	// hard_deny is a boundary the model is told it may not clear. Enforce it here
	// too: a prompt-injected "allow" on a hard_deny rule must not get through,
	// and there is no operator prompt to soften it either, because a boundary a
	// user can wave through is not a boundary.
	if (verdict.rule_kind === "hard_deny") {
		return { block: true, reason: `hard_deny: ${verdict.reason || "security boundary"}` };
	}
	if (verdict.decision === "deny") {
		return { block: true, reason: verdict.reason || "denied by the auto-mode classifier" };
	}
	return undefined;
}
