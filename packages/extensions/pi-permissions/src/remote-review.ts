import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BlockAsk } from "./ui/block-prompt.ts";
import type { BlockAnswer } from "./ui/block-prompt-state.ts";
import { canonicalJson } from "./ui/call-label.ts";

export const REMOTE_REVIEW_REGISTER = "permissions:remote-review:v1:register";
export interface RemoteReviewRequest {
	version: 1;
	id: string;
	sessionId: string;
	scopeId: string;
	title: string;
	options: readonly string[];
	timeoutMs: number;
}
/** Trusted extension transport, not a model tool or a permission/configuration override. */
export interface RemoteReviewRegistration {
	version: 1;
	sessionId: string;
	scopeId: string;
	isLive: () => boolean;
	select: (request: Readonly<RemoteReviewRequest>, signal: AbortSignal) => Promise<string | undefined>;
	accepted?: boolean;
	dispose?: () => void;
}
type Provider = Pick<RemoteReviewRegistration, "scopeId" | "isLive" | "select">;

/** Only transports native-authored reviews; the caller still owns all eligibility and ledger checks. */
export class RemotePermissionReview {
	private session: {id: string; cwd: string} | undefined;
	private provider: Provider | undefined;
	private readonly pending = new Set<AbortController>();
	constructor(events: Pick<ExtensionAPI["events"], "on">) {
		events.on(REMOTE_REVIEW_REGISTER, data => {
			try { this.register(data); } catch { /* Malformed registrations never grant authority. */ }
		});
	}
	begin(ctx: ExtensionContext): void {
		this.close();
		if (ctx.mode === "rpc" && ctx.hasUI) this.session = {id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd};
	}
	close(): void {
		this.session = undefined;
		this.provider = undefined;
		for (const pending of this.pending) pending.abort();
		this.pending.clear();
	}
	available(ctx: ExtensionContext): boolean {
		try {
			return !!this.session && !!this.provider && ctx.mode === "rpc" && ctx.hasUI && !ctx.signal?.aborted &&
				ctx.sessionManager.getSessionId() === this.session.id && ctx.cwd === this.session.cwd && this.provider.isLive() === true;
		} catch { return false; }
	}
	scopeId(ctx: ExtensionContext): string | undefined {
		return this.available(ctx) ? this.provider?.scopeId : undefined;
	}
	private register(data: unknown): void {
		if (!data || typeof data !== "object" || Object.isFrozen(data)) return;
		const registration = data as Partial<RemoteReviewRegistration>;
		registration.accepted = false;
		if (registration.version !== 1 || !this.session || this.provider || registration.sessionId !== this.session.id ||
			typeof registration.scopeId !== "string" || !/^[\x21-\x7e]{1,128}$/.test(registration.scopeId) ||
			typeof registration.isLive !== "function" || typeof registration.select !== "function") return;
		const provider: Provider = {scopeId: registration.scopeId, isLive: registration.isLive, select: registration.select};
		registration.dispose = () => {
			if (this.provider !== provider) return;
			this.provider = undefined;
			for (const pending of this.pending) pending.abort();
		};
		registration.accepted = true;
		this.provider = provider;
	}
	async ask(ctx: ExtensionContext, ask: BlockAsk): Promise<BlockAnswer | undefined> {
		if (!this.available(ctx)) return;
		const provider = this.provider!, session = this.session!;
		const timeoutMs = ask.timeoutSeconds * 1000;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000 || (ask.scopeOnly && !ask.scope)) return;
		const snapshot = () => canonicalJson({toolName: ask.toolName, input: ask.input, reason: ask.reason, scope: ask.scope, scopeOnly: ask.scopeOnly, cwd: ctx.cwd});
		let original: string;
		try { original = snapshot(); } catch { return; }
		const title = `${ask.title ?? "Native permission review"}\n\nOriginal action and scope (not executed):\n${original}\n\nHard restrictions still apply. No future-session grants are offered.`;
		// Never truncate an action into a different, apparently approvable request.
		if (title.length > 32768 || Buffer.byteLength(JSON.stringify({title})) > 120000) return;
		const choices: Array<{label: string; answer: BlockAnswer}> = [{label: "Deny", answer: "deny"}];
		if (!ask.scopeOnly) choices.push({label: "Allow this exact action once", answer: "allow"});
		if (ask.scope) choices.push({label: "Allow the displayed session scope", answer: "allow-session"});
		const request: Readonly<RemoteReviewRequest> = Object.freeze({version: 1, id: randomUUID(), sessionId: session.id, scopeId: provider.scopeId, title, options: Object.freeze(choices.map(choice => choice.label)), timeoutMs});
		const controller = new AbortController(), signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
		const deadline = performance.now() + timeoutMs;
		let onAbort!: () => void;
		const cancelled = new Promise<undefined>(resolve => {
			onAbort = () => resolve(undefined);
			signal.addEventListener("abort", onAbort, {once: true});
		});
		this.pending.add(controller);
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const answer = await Promise.race([Promise.resolve().then(() => signal.aborted ? undefined : provider.select(request, signal)).catch(() => undefined), cancelled]);
			if (signal.aborted || performance.now() >= deadline || this.provider !== provider || this.session !== session || !this.available(ctx) || snapshot() !== original) return;
			return choices.find(choice => choice.label === answer)?.answer;
		} catch { return; }
		finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			this.pending.delete(controller);
			controller.abort();
		}
	}
}
