import { requestedDirectories } from "./directory-access.ts";
import type { PromptPermissionDetails } from "./engine/authority/permission-prompter.ts";
import type { PermissionPromptDecision } from "./engine/authority/permission-dialog.ts";
import { wasInterrupted } from "./engine/authority/decision-source.ts";
import { eventFromDetails } from "./auto/permission-chain.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { DETERMINISTIC_ONLY, type PermissionChainOptions } from "./auto/permission-chain.ts";
import { grantKey, type PermissionOwner, PermissionLedger } from "./denials.ts";
import { asForwardedToolCall } from "./engine/authority/forwarded-tool-call.ts";

/** Keep concurrent child requests out of each other's grants and the parent's scopes. */
export function createForwardedGate(ledger: PermissionLedger, persist: () => void) {
	const context = new AsyncLocalStorage<PermissionOwner>();
	const wrap: NonNullable<PermissionChainOptions["wrapForwarded"]> = (handler, details) => async (event, ctx) => {
		const forwarding = details.forwarding as { requesterSessionId?: string; requesterAgentName?: string; requesterCwd?: string };
		const owner: PermissionOwner = {
			sessionId: forwarding.requesterSessionId ?? "",
			agentName: forwarding.requesterAgentName ?? "unknown",
			cwd: forwarding.requesterCwd,
		};
		const childCtx = new Proxy(ctx, {
			get(target, property, receiver) {
				if (property === "cwd" && owner.cwd) return owner.cwd;
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return context.run(owner, async () => {
			const complete = !!asForwardedToolCall(details.toolCall);
			const granted = complete && !!owner.sessionId && ledger.isGranted(event.toolName, event.input, owner);
			// Exact child grants bypass classification, not deterministic policy.
			const deterministic = { ...event, [DETERMINISTIC_ONLY]: true };
			const result = await handler(granted ? deterministic : event, childCtx);
			if (result?.block && !/interrupted the turn/i.test(result.reason ?? "")) {
				const reason = result.reason ?? "";
				const duplicate = ledger.open().some(d => d.toolCallId === event.toolCallId && d.reason === reason &&
					grantKey(d.toolName, d.input, d.owner) === grantKey(event.toolName, event.input, owner));
				if (!duplicate) {
					ledger.record({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, reason, owner, directories: requestedDirectories(details, childCtx.cwd), ...(!complete ? { incomplete: true } : {}) });
					persist();
				}
			}
			return result;
		});
	};
	const recordDecision = (details: PromptPermissionDetails, decision: PermissionPromptDecision) => {
		if (decision.approved || wasInterrupted(decision.decidedBy) || !details.forwarding) return;
		const call = eventFromDetails({ ...details });
		if (!call) return;
		const owner: PermissionOwner = {
			sessionId: details.forwarding.requesterSessionId ?? "",
			agentName: details.forwarding.requesterAgentName ?? "unknown",
			cwd: details.forwarding.requesterCwd,
		};
		if (ledger.open().some(d => d.toolCallId === call.toolCallId && grantKey(d.toolName, d.input, d.owner) === grantKey(call.toolName, call.input, owner))) return;
		ledger.record({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input,
			reason: decision.denialReason ?? "Denied by the serving session's permission policy", owner,
			directories: requestedDirectories({ ...details }, owner.cwd ?? ""),
			incomplete: !asForwardedToolCall(details.toolCall), policyDenied: decision.decidedBy?.kind === "rule" });
		persist();
	};
	return { wrap, owner: () => context.getStore(), recordDecision };
}
