import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { approvalLabel, type Denial, PermissionLedger } from "./denials.ts";
import { askBeforeBlock } from "./ui/block-prompt.ts";
import { canonicalJson } from "./ui/call-label.ts";

export function denialGuidance(denial: Denial): string {
	const reference = ` Denial reference: ${denial.id}.`;
	if (denial.review?.response === "denied") return `${reference} The user explicitly declined. Do not retry or ask again without a new instruction. Independent work can continue.`;
	return `${reference} ${denial.review?.response === "timeout" ? "The automatic approval popup timed out. " : ""}Do not routinely ask again after a denial. Independent work can continue. If Goal mode is active, use goal_wait(waiting_for="user") only if this approval actually blocks the goal and no independent work remains. The user can review /permissions.${denial.review?.eligible ? " ask_for_approval can explicitly review this denial when a separate request is genuinely necessary; it is not the default next step." : " Linked approval cannot override hard restrictions."}`;
}

export function registerApprovalRequest(pi: ExtensionAPI, ledger: PermissionLedger, persist: () => void, ask = askBeforeBlock): void {
	pi.registerTool({
		name: "ask_for_approval",
		label: "Review denied action",
		description: "Request explicit user review of a recorded auto-mode soft denial in this session. Supply the denialId from the blocked tool result; the UI shows the original action and scope, not agent-authored substitutes. An approval updates the permission ledger directly—no second menu approval is needed. The action must still be retried and rechecked; hard restrictions cannot be overridden. The automatic popup is the primary request: do not routinely call this after a denial or repeatedly ask after timeout/rejection. Continue independent work. During an active /goal, use goal_wait(waiting_for=\"user\") only when approval actually blocks the goal and no independent work remains. Use this tool only when a separate explicit review is genuinely necessary. Child-owned and historical denials without review metadata are not supported.",
		parameters: Type.Object({ denialId: Type.String({ minLength: 1, description: "Exact denial reference from the blocked tool result (for example d1)." }) }),
		async execute(_id, { denialId }, signal, _onUpdate, ctx) {
			let requestId: string | undefined;
			const publish = (channel: string, data: Record<string, unknown>) => {
				try { pi.events.emit(channel, data); } catch { /* Notifications cannot decide authority. */ }
			};
			const result = (status: string, text: string) => {
				if (requestId) publish("permissions:decision", { requestId, surface: denial!.toolName, result: status === "approved" ? "allow" : "deny", resolution: status === "approved" ? "user_approved" : denial?.review?.response === "denied" ? "user_denied" : "confirmation_unavailable" });
				return { content: [{ type: "text" as const, text }], details: { denialId, status } };
			};
			const denial = ledger.open().find((d) => d.id === denialId);
			const eligible = () => denial && denial.state === "open" && denial.review?.eligible === true && denial.review.response !== "denied" && !denial.owner && !denial.incomplete && !denial.policyDenied && denial.cwd === ctx.cwd && denial.sessionId === ctx.sessionManager.getSessionId();
			if (!ctx.hasUI || ctx.mode !== "tui" || signal?.aborted || !eligible() || !denial || denial.reviewRequested)
				return result("unavailable", "No new approval question was opened. This denial is unavailable, already reviewed, explicitly rejected, or not eligible for linked approval. The action remains blocked; do not repeatedly ask. You can review /permissions directly.");
			const scope = approvalLabel(denial.toolName, denial.input, ctx.cwd, denial.directories);
			if (!scope) return result("unavailable", "This denial has no supported bounded approval scope. No approval was granted.");
			const sessionId = ctx.sessionManager.getSessionId();
			const reference = () => canonicalJson({ toolName: denial.toolName, input: denial.input, cwd: denial.cwd, directories: denial.directories, review: denial.review });
			const original = reference();
			// Claim before awaiting the UI so parallel calls cannot open duplicate requests.
			denial.reviewRequested = true;
			persist();
			requestId = `pi-permissions-review-${sessionId}-${denial.id}`;
			publish("permissions:ui_prompt", { requestId, toolName: denial.toolName, surface: denial.toolName });
			let answer;
			try {
				answer = await ask({ ...ctx, signal }, { title: `Review denial ${denial.id}`, toolName: denial.toolName, input: denial.input, reason: denial.reason, scope, scopeOnly: true, timeoutSeconds: 30 });
			} catch {
				return result("blocked", "The approval UI could not finish. No approval was granted; the action remains blocked.");
			}
			if (signal?.aborted || ctx.sessionManager.getSessionId() !== sessionId || !ledger.open().includes(denial) || !eligible() || reference() !== original)
				return result("stale", "The request was cancelled or the session, action, or denial changed during review. No approval was granted.");
			if (answer === "deny") {
				pi.events.emit("pi-user-decision:submitted", { source: "permission-approval", denialId });
				ledger.reject(denial.id);
				persist();
			}
			if (answer !== "allow-session") return result("blocked", denialGuidance(denial).trim());
			// Expire earlier intent before storing this answer, never immediately after it.
			pi.events.emit("pi-user-decision:submitted", { source: "permission-approval", denialId });
			ledger.rememberScope(denial.toolName, denial.input, ctx.cwd, denial.directories);
			denial.state = "approved";
			persist();
			return result("approved", `You approved the displayed scope for denial ${denial.id}. No action ran. Retry the original action only if still needed; policy and risk checks remain in force. No additional permissions-menu approval is required.`);
		},
	});
}
