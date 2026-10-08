// The /permissions menu as state: which tab, which row, and what a key asks
// for. Pure; the view draws it and index.ts carries out what it returns.
//
// Four tabs: what was blocked, what you approved, auto mode, and the
// permission system's settings. The last two are rows of settings, supplied
// by index.ts from the two halves.

import type { Denial, Grant, PermissionLedger } from "../denials.ts";

export type MenuTab = "denied" | "granted" | "auto" | "settings";
export const TABS: readonly MenuTab[] = ["denied", "granted", "auto", "settings"];

/** One row of a settings tab. */
export interface SettingRow {
	id: string;
	label: string;
	value?: string;
	/** Shown under the row when it is highlighted. */
	description?: string;
	/** A config warning, drawn as one. */
	warning?: boolean;
	/** Whether Enter does something here; the rest only show a value. */
	actionable: boolean;
}

export interface SettingRows {
	auto(): SettingRow[];
	settings(): SettingRow[];
}

export type MenuEffect =
	| { kind: "approve"; denial: Denial }
	| { kind: "dismiss"; denial: Denial }
	| { kind: "revoke"; grant: Grant }
	| { kind: "act"; tab: "auto" | "settings"; row: SettingRow }
	| { kind: "close" };

export type MenuKey = "up" | "down" | "next" | "prev" | "select" | "approve" | "remove" | "close";

export class PermissionsMenu {
	cursor = 0;

	constructor(
		private readonly ledger: PermissionLedger,
		private readonly settingRows: SettingRows,
		public tab: MenuTab = "denied",
	) {}

	denied(): Denial[] {
		return this.ledger.open();
	}

	granted(): Grant[] {
		return this.ledger.grantList();
	}

	rows(): SettingRow[] {
		if (this.tab === "auto") return this.settingRows.auto();
		if (this.tab === "settings") return this.settingRows.settings();
		return [];
	}

	private count(): number {
		if (this.tab === "denied") return this.denied().length;
		if (this.tab === "granted") return this.granted().length;
		return this.rows().length;
	}

	private switchTab(delta: number): void {
		const i = TABS.indexOf(this.tab);
		this.tab = TABS[(i + delta + TABS.length) % TABS.length]!;
		this.cursor = 0;
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
			case "next":
				this.switchTab(1);
				return undefined;
			case "prev":
				this.switchTab(-1);
				return undefined;
			case "close":
				return { kind: "close" };
			case "approve":
			case "select": {
				if (this.tab === "denied") {
					const denial = this.denied()[this.cursor];
					return denial ? { kind: "approve", denial } : undefined;
				}
				if (key === "approve" || this.tab === "granted") return undefined;
				const row = this.rows()[this.cursor];
				return row?.actionable ? { kind: "act", tab: this.tab, row } : undefined;
			}
			case "remove": {
				if (this.tab === "denied") {
					const denial = this.denied()[this.cursor];
					return denial ? { kind: "dismiss", denial } : undefined;
				}
				if (this.tab === "granted") {
					const grant = this.granted()[this.cursor];
					return grant ? { kind: "revoke", grant } : undefined;
				}
				return undefined;
			}
		}
	}

	/** After an effect has been carried out and the lists have changed. */
	settle(): void {
		this.cursor = Math.max(0, Math.min(this.cursor, this.count() - 1));
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
