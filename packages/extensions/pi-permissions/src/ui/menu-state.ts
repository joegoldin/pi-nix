// The /permissions menu as state: which tab, which row, and what a key asks
// for. Pure; the view draws it and index.ts carries out what it returns.

import type { Denial, Grant, PermissionLedger } from "../denials.ts";

export type MenuTab = "denied" | "granted";

export type MenuEffect =
	| { kind: "approve"; denial: Denial }
	| { kind: "dismiss"; denial: Denial }
	| { kind: "revoke"; grant: Grant }
	| { kind: "close" };

export type MenuKey = "up" | "down" | "tab" | "approve" | "remove" | "close";

export class PermissionsMenu {
	tab: MenuTab = "denied";
	cursor = 0;

	constructor(private readonly ledger: PermissionLedger) {}

	denied(): Denial[] {
		return this.ledger.open();
	}

	granted(): Grant[] {
		return this.ledger.grantList();
	}

	private count(): number {
		return this.tab === "denied" ? this.denied().length : this.granted().length;
	}

	/** Keep the cursor on a row after the list shrinks. */
	private clamp(): void {
		this.cursor = Math.max(0, Math.min(this.cursor, this.count() - 1));
	}

	press(key: MenuKey): MenuEffect | undefined {
		const n = this.count();
		switch (key) {
			case "up":
				if (n) this.cursor = (this.cursor - 1 + n) % n;
				return undefined;
			case "down":
				if (n) this.cursor = (this.cursor + 1) % n;
				return undefined;
			case "tab":
				this.tab = this.tab === "denied" ? "granted" : "denied";
				this.cursor = 0;
				return undefined;
			case "close":
				return { kind: "close" };
			case "approve": {
				if (this.tab !== "denied") return undefined;
				const denial = this.denied()[this.cursor];
				return denial ? { kind: "approve", denial } : undefined;
			}
			case "remove": {
				if (this.tab === "denied") {
					const denial = this.denied()[this.cursor];
					return denial ? { kind: "dismiss", denial } : undefined;
				}
				const grant = this.granted()[this.cursor];
				return grant ? { kind: "revoke", grant } : undefined;
			}
		}
	}

	/** After an effect has been carried out and the lists have changed. */
	settle(): void {
		this.clamp();
	}
}

/** "just now", "40s ago", "12m ago", "3h ago". */
export function ago(at: number, now: number): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 5) return "just now";
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	return `${Math.floor(s / 3600)}h ago`;
}
