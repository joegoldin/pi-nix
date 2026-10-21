// What was blocked, and what you have since allowed. index.ts persists the
// ledger in the session; the prompt and /permissions menu both use it.
//
// Legacy and non-shell menu grants retain their session-wide overrides.
// Shell menu and scoped prompt grants pass policy checks, expire on new user
// intent, and can be revoked from the same menu.

import { resolve } from "node:path";
import { resolvePathForPolicy, resolveToolInputPath } from "./auto/paths.ts";
import { canonicalJson } from "./ui/call-label.ts";
import type { ScenarioApproval } from "./auto/types.ts";

export interface ApprovalScope {
	key: string;
	label: string;
	/** Absent on legacy grants, whose displayed scope only covered the exact command. */
	scenario?: { cwd: string };
}

/** Variants need classifier review; the key still identifies only an exact reusable scope. */
export function approvalScope(toolName: string, input: unknown, cwd: string): ApprovalScope | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const args = { ...input as Record<string, unknown> };
	const directory = resolvePathForPolicy(resolve(cwd)) ?? resolve(cwd);
	let label: string;
	let scenario: ApprovalScope["scenario"];
	if ((toolName === "bash" || toolName === "bg_run") && typeof args.command === "string") {
		delete args.timeout;
		if (toolName === "bg_run") {
			delete args.timeoutSeconds;
			delete args.name;
			delete args.description;
		}
		scenario = { cwd: directory };
		label = `Similar shell actions for this task in ${directory}: same targets (hosts, repositories, directories, services and recipients) and side-effect types. Arguments and diagnostic filenames may vary; each action is rechecked`;
	} else if ((toolName === "edit" || toolName === "write") && typeof args.path === "string") {
		const path = resolveToolInputPath(toolName, directory, args.path);
		if (path === undefined) return undefined;
		args.path = resolvePathForPolicy(path) ?? path;
		if (toolName === "edit") delete args.edits;
		else delete args.content;
		label = `${toolName} ${args.path} in ${directory} (new contents/edits allowed)`;
	} else return undefined;
	return { key: `scope\u0000${directory}\u0000${toolName}\u0000${canonicalJson(args)}`, label: `${label}; until your next instruction or questionnaire answer`, ...(scenario ? { scenario } : {}) };
}

export type DenialState = "open" | "approved" | "dismissed";

export interface Denial {
	id: string;
	/** When it was blocked, epoch milliseconds. */
	at: number;
	toolCallId: string;
	toolName: string;
	input: unknown;
	/** The reason the agent was given. */
	reason: string;
	state: DenialState;
}

export interface Grant {
	key: string;
	toolName: string;
	input: unknown;
	at: number;
	/** Scoped approvals still pass deterministic denies; exact menu grants are separate. */
	scope?: ApprovalScope;
}

/** The record as it is persisted in the session. */
export interface PermissionRecord {
	denials: Denial[];
	grants: Grant[];
}

/** How many denials are kept, newest first; older ones drop off. */
export const DENIAL_LIMIT = 50;

export function grantKey(toolName: string, input: unknown): string {
	return `${toolName}\u0000${canonicalJson(input ?? {})}`;
}

export class PermissionLedger {
	private denials: Denial[] = [];
	private grants = new Map<string, Grant>();
	private nextId = 1;

	constructor(private readonly now: () => number = Date.now) {}

	record(blocked: Omit<Denial, "id" | "at" | "state">): Denial {
		const denial: Denial = { ...blocked, id: `d${this.nextId++}`, at: this.now(), state: "open" };
		this.denials = [denial, ...this.denials].slice(0, DENIAL_LIMIT);
		return denial;
	}

	/** Newest first. */
	list(): readonly Denial[] {
		return this.denials;
	}

	open(): Denial[] {
		return this.denials.filter((d) => d.state === "open");
	}

	/** Menu shell approvals inform classification; legacy/non-shell grants stay exact. */
	approve(id: string, cwd?: string): Denial | undefined {
		const denial = this.denials.find((d) => d.id === id);
		if (!denial) return undefined;
		const key = grantKey(denial.toolName, denial.input);
		const scoped = cwd && (denial.toolName === "bash" || denial.toolName === "bg_run")
			? this.approveSimilar(denial.toolName, denial.input, cwd) : undefined;
		if (!scoped && !this.grants.has(key)) this.grants.set(key, { key, toolName: denial.toolName, input: denial.input, at: this.now() });
		for (const d of this.denials) {
			if (d.state === "open" && grantKey(d.toolName, d.input) === key) d.state = "approved";
		}
		return denial;
	}

	dismiss(id: string): void {
		const denial = this.denials.find((d) => d.id === id);
		if (denial?.state === "open") denial.state = "dismissed";
	}

	isGranted(toolName: string, input: unknown): boolean {
		return this.grants.has(grantKey(toolName, input));
	}

	approveSimilar(toolName: string, input: unknown, cwd: string): Grant | undefined {
		const scope = approvalScope(toolName, input, cwd);
		if (!scope) return undefined;
		const grant = { key: scope.key, toolName, input: structuredClone(input), at: this.now(), scope };
		this.grants.set(scope.key, grant);
		return grant;
	}

	isSimilarlyGranted(toolName: string, input: unknown, cwd: string): boolean {
		const scope = approvalScope(toolName, input, cwd);
		return !!scope && this.grants.has(scope.key);
	}

	/** Only newly displayed shell scenarios can inform review of different commands. */
	scenarioApprovals(toolName: string, cwd: string): ScenarioApproval[] {
		if (toolName !== "bash" && toolName !== "bg_run") return [];
		const directory = resolvePathForPolicy(resolve(cwd)) ?? resolve(cwd);
		const approvals: ScenarioApproval[] = [];
		for (const grant of this.grantList()) {
			const scope = grant.scope;
			if (!scope?.scenario || scope.scenario.cwd !== directory) continue;
			if (grant.toolName !== "bash" && grant.toolName !== "bg_run") continue;
			approvals.push({ scope: scope.label, cwd: directory, toolName: grant.toolName, input: structuredClone(grant.input), at: grant.at });
		}
		return approvals;
	}

	clearSimilar(): boolean {
		let changed = false;
		for (const [key, grant] of this.grants) {
			if (grant.scope) {
				this.grants.delete(key);
				changed = true;
			}
		}
		return changed;
	}

	/** Newest first. */
	grantList(): Grant[] {
		return [...this.grants.values()].sort((a, b) => b.at - a.at);
	}

	revoke(key: string): void {
		this.grants.delete(key);
	}

	snapshot(): PermissionRecord {
		return { denials: this.denials.map((d) => ({ ...d })), grants: this.grantList() };
	}

	restore(record: PermissionRecord | undefined): void {
		this.denials = Array.isArray(record?.denials) ? record.denials.slice(0, DENIAL_LIMIT).map((d) => ({ ...d })) : [];
		this.grants = new Map((Array.isArray(record?.grants) ? record.grants : []).map((g) => [g.key, { ...g }]));
		const highest = Math.max(0, ...this.denials.map((d) => Number(d.id.slice(1)) || 0));
		this.nextId = highest + 1;
	}
}
