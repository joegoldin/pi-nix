// What was blocked, and what you have since allowed. Pure: index.ts records
// into it from the tool_call handlers it wraps, persists it in the session,
// and the /permissions menu acts on it.
//
// A grant is for one exact call, the tool and its input as written, and lasts
// for the session. It passes both halves of the extension, hard denies
// included: it is your own decision, taken after the block, with the call in
// front of you.

import { canonicalJson } from "./ui/call-label.ts";

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

	/** Allow this exact call for the session, and mark every open denial of it approved. */
	approve(id: string): Denial | undefined {
		const denial = this.denials.find((d) => d.id === id);
		if (!denial) return undefined;
		const key = grantKey(denial.toolName, denial.input);
		if (!this.grants.has(key)) this.grants.set(key, { key, toolName: denial.toolName, input: denial.input, at: this.now() });
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
