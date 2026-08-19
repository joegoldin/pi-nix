// Delegation to @gotgenes/pi-permission-system — design §9's second build step.
//
// ASSUMPTION A2 IS MOOT. The design worried that two extensions on `tool_call`
// might have unobservable ordering. They do not need ordering: the package
// publishes a typed service on Symbol.for("@gotgenes/pi-permission-system:service")
// and a registerAuthorizer() chain seam that fires ONLY for asks the
// deterministic engine could not resolve. That is a direct call.
//
// We reach the symbol slot directly rather than importing the package, so
// pi-auto-mode has no dependency on it: when the extension is absent the slot is
// empty, attachAuthorizer answers false, and the built-in matcher from rules.ts
// stays in charge. That is exactly the fallback state §9 wanted shipped.
//
// A chain link returns `defer` — never `allow` — when it cannot decide. Deferring
// hands the ask back to the chain owner, whose own prompt path is the fail-closed
// behaviour at that layer. Returning `allow` there would widen permissions on
// failure, which §9 forbids.
//
// ACTIVATION IS NOT REGISTRATION. Registering a link makes it available; the
// package consults it only when the operator names it in `authorizerChain`
// inside ~/.pi/agent/extensions/pi-permission-system/config.json, which is that
// package's own config file rather than pi's settings.json. Nothing in this
// repo can write that file yet, so `delegateToPermissionSystem` is documented as
// requiring an operator edit on the other side.

import type { ClassifierVerdict } from "./classifier.ts";
import type { AutoModePromptEvent } from "./config.ts";
import type { ToolRequest } from "./request.ts";

export const PERMISSION_SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:service");
export const PERMISSIONS_READY_CHANNEL = "permissions:ready";
export const AUTHORIZER_NAME = "pi-auto-mode";

export type AuthorizerVerdict = { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" };

export interface AuthorizerLogLike {
	review(event: string, details?: Record<string, unknown>): void;
	debug(event: string, details?: Record<string, unknown>): void;
}

export type AuthorizeFn = (
	details: Record<string, unknown>,
	query: unknown,
	log: AuthorizerLogLike,
) => Promise<AuthorizerVerdict>;

export interface PermissionsServiceLike {
	registerAuthorizer(name: string, authorize: AuthorizeFn): () => void;
}

export function getPermissionsService(global: typeof globalThis = globalThis): PermissionsServiceLike | undefined {
	const slot = (global as unknown as Record<symbol, unknown>)[PERMISSION_SERVICE_KEY];
	if (typeof slot !== "object" || slot === null) return undefined;
	if (typeof (slot as PermissionsServiceLike).registerAuthorizer !== "function") return undefined;
	return slot as PermissionsServiceLike;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function surfaceOf(toolName: string): string {
	if (toolName === "bash") return "bash";
	if (toolName === "write" || toolName === "edit") return "write";
	if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return "read";
	return "tool";
}

/** Projects a PromptPermissionDetails onto the ToolRequest the classifier takes. */
export function requestFromDetails(details: Record<string, unknown>): ToolRequest {
	const toolName = str(details.toolName) ?? "";
	const value = str(details.command) ?? str(details.path) ?? str(details.target) ?? str(details.value) ?? "";
	// PromptPermissionDetails carries its own display surface, and a forwarded
	// subagent ask carries the child's rather than one derivable from toolName.
	// Prefer it; fall back to the same mapping renderRequest uses.
	const surface = str(details.surface) ?? surfaceOf(toolName);
	return { toolName, toolCallId: str(details.toolCallId) ?? "", surface, value, input: {} };
}

export interface AuthorizerDeps {
	classify(request: ToolRequest, userTurns: string[]): Promise<ClassifierVerdict>;
	userTurns(): string[];
	onPrompt(event: AutoModePromptEvent): void;
}

export function makeAuthorizer(deps: AuthorizerDeps): AuthorizeFn {
	return async (details, _query, log) => {
		const request = requestFromDetails(details);

		let verdict: ClassifierVerdict;
		try {
			verdict = await deps.classify(request, deps.userTurns());
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			deps.onPrompt({
				toolName: request.toolName,
				toolCallId: request.toolCallId,
				value: request.value,
				detail,
			});
			log.debug(AUTHORIZER_NAME, { requestId: details.requestId, error: detail });
			return { kind: "defer" };
		}

		const denied = verdict.rule_kind === "hard_deny" || verdict.decision === "deny";
		log.review(AUTHORIZER_NAME, {
			requestId: details.requestId,
			decision: denied ? "deny" : "allow",
			ruleKind: verdict.rule_kind,
			reason: verdict.reason,
		});

		if (verdict.rule_kind === "hard_deny") {
			return { kind: "deny", reason: `hard_deny: ${verdict.reason || "security boundary"}` };
		}
		if (verdict.decision === "deny") {
			return { kind: "deny", reason: verdict.reason || "denied by the auto-mode classifier" };
		}
		return { kind: "allow" };
	};
}

/**
 * Registers the chain link, now and on every `permissions:ready`, which is the
 * package's documented registration point and is re-emitted on `/reload`.
 *
 * Returns whether the link is registered right now. The caller uses that to
 * decide whether its own classifier gate still has work to do.
 */
export function attachAuthorizer(
	pi: { events: { on(channel: string, handler: (data: unknown) => void): () => void } },
	makeDeps: () => AuthorizerDeps,
	global: typeof globalThis = globalThis,
): boolean {
	const register = (): boolean => {
		const service = getPermissionsService(global);
		if (service === undefined) return false;
		try {
			service.registerAuthorizer(AUTHORIZER_NAME, makeAuthorizer(makeDeps()));
			return true;
		} catch {
			// Duplicate registration throws by contract. Report false rather than
			// true: we cannot tell a benign second ready event from a name another
			// extension took, and the safe reading of "cannot tell" is that our
			// link is not the one on the chain.
			return false;
		}
	};
	pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
		register();
	});
	return register();
}
