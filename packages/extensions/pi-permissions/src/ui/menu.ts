// The /permissions menu, the one place for permissions: what was blocked, to
// approve or dismiss; what you approved, to revoke; auto mode; and the
// permission system's settings. Drawn as pi-custom draws /context and /ui:
// framed, in the editor's place, the selected row opened up.

import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Denial, Grant } from "../denials.ts";
import { callLabel, shortReason } from "./call-label.ts";
import { Framed, type FrameTheme } from "./frame.ts";
import { ago, type MenuEffect, type MenuKey, type MenuTab, type PermissionsMenu, type SettingRow } from "./menu-state.ts";

export interface MenuTheme extends FrameTheme {
	bold(text: string): string;
	bg?(slot: string, text: string): string;
}

/** Rows of detail shown for the selected denial's input. */
const INPUT_ROWS = 8;

export class PermissionsMenuView {
	constructor(
		private readonly menu: PermissionsMenu,
		private readonly theme: MenuTheme,
		private readonly onEffect: (effect: MenuEffect) => void,
		private readonly height: () => number,
		private readonly now: () => number = Date.now,
	) {}

	handleInput(data: string): void {
		const key = this.keyOf(data);
		if (!key) return;
		const effect = this.menu.press(key);
		if (effect) this.onEffect(effect);
		this.menu.settle();
	}

	private keyOf(data: string): MenuKey | undefined {
		if (matchesKey(data, "escape") || data === "q") return "close";
		if (matchesKey(data, "up") || data === "k") return "up";
		if (matchesKey(data, "down") || data === "j") return "down";
		if (matchesKey(data, "tab") || matchesKey(data, "right")) return "next";
		if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) return "prev";
		if (matchesKey(data, "enter") || data === " ") return "select";
		if (data === "a") return "approve";
		if (data === "x" || data === "d") return "remove";
		return undefined;
	}

	render(width: number): string[] {
		const { menu, theme } = this;
		const denied = menu.denied();
		const granted = menu.granted();
		const chip = (text: string, tab: MenuTab) =>
			menu.tab === tab
				? theme.bg
					? theme.bg("selectedBg", ` ${text} `)
					: theme.fg("accent", theme.bold(` ${text} `))
				: theme.fg("muted", ` ${text} `);
		const lines = [
			[chip(`Denied (${denied.length})`, "denied"), chip(`Allowed (${granted.length})`, "granted"), chip("Auto mode", "auto"), chip("Settings", "settings")].join(" "),
			"",
		];
		const body =
			menu.tab === "denied"
				? this.deniedRows(denied, width)
				: menu.tab === "granted"
					? this.grantedRows(granted, width)
					: this.settingRows(menu.rows(), width);
		lines.push(...this.window(body, Math.max(4, this.height() - 4)));
		lines.push("");
		lines.push(theme.fg("dim", HINTS[menu.tab]));
		return lines;
	}

	/** A settings tab: label, value, and the highlighted row's description under it. */
	private settingRows(rows: SettingRow[], width: number): { rows: string[]; focus: number } {
		const { theme, menu } = this;
		const labelWidth = Math.max(0, ...rows.map((r) => r.label.length)) + 2;
		const out: string[] = [];
		let focus = 0;
		rows.forEach((row, i) => {
			const here = i === menu.cursor;
			if (here) focus = out.length;
			const pointer = here ? theme.fg("accent", "❯ ") : "  ";
			const label = row.label.padEnd(labelWidth);
			const value = row.value ?? "";
			const shownValue = row.warning ? theme.fg("warning", value) : row.actionable ? theme.fg("accent", value) : theme.fg("muted", value);
			out.push(truncateToWidth(`${pointer}${here ? theme.bold(label) : label}${shownValue}`, width, "…"));
			if (here && row.description) {
				for (const part of wrapTextWithAnsi(row.description, Math.max(1, width - 4))) out.push(theme.fg("dim", `    ${part}`));
			}
		});
		return { rows: out, focus };
	}

	/** Rows per item, the selected item opened up; returns the rows and where the cursor's item starts. */
	private deniedRows(denied: Denial[], width: number): { rows: string[]; focus: number } {
		const { theme, menu } = this;
		if (denied.length === 0) return { rows: [theme.fg("muted", "Nothing blocked is waiting.")], focus: 0 };
		const rows: string[] = [];
		let focus = 0;
		denied.forEach((d, i) => {
			const here = i === menu.cursor;
			if (here) focus = rows.length;
			rows.push(this.headline(d.toolName, d.input, ago(d.at, this.now()), here, width));
			if (!here) {
				rows.push(theme.fg("muted", truncateToWidth(`     ${shortReason(d.reason).replace(/\s+/g, " ")}`, width, "…")));
				return;
			}
			for (const part of wrapTextWithAnsi(shortReason(d.reason), Math.max(1, width - 5))) rows.push(theme.fg("muted", `     ${part}`));
			const input = JSON.stringify(d.input, null, 2).split("\n");
			const shown = input.slice(0, INPUT_ROWS);
			for (const line of shown) rows.push(theme.fg("dim", truncateToWidth(`     ${line}`, width, "…")));
			if (input.length > shown.length) rows.push(theme.fg("dim", `     … ${input.length - shown.length} more lines`));
		});
		return { rows, focus };
	}

	private grantedRows(granted: Grant[], width: number): { rows: string[]; focus: number } {
		const { theme, menu } = this;
		if (granted.length === 0) return { rows: [theme.fg("muted", "Nothing approved yet.")], focus: 0 };
		const rows: string[] = [];
		let focus = 0;
		granted.forEach((g, i) => {
			const here = i === menu.cursor;
			if (here) focus = rows.length;
			rows.push(this.headline(g.toolName, g.input, `approved ${ago(g.at, this.now())}`, here, width, "success"));
		});
		return { rows, focus };
	}

	private headline(toolName: string, input: unknown, when: string, here: boolean, width: number, bullet = "warning"): string {
		const { theme } = this;
		const { title, target } = callLabel(toolName, input);
		const pointer = here ? theme.fg("accent", "❯ ") : "  ";
		const name = here ? theme.bold(title) : title;
		const tail = theme.fg("dim", `  ${when}`);
		const head = `${pointer}${theme.fg(bullet, "●")} ${name}${target ? theme.fg("muted", `(${target})`) : ""}`;
		return `${truncateToWidth(head, Math.max(1, width - when.length - 2), "…")}${tail}`;
	}

	/** The rows that fit, scrolled so the selected item's first row shows. */
	private window(body: { rows: string[]; focus: number }, height: number): string[] {
		if (body.rows.length <= height) return body.rows;
		const top = Math.max(0, Math.min(body.focus, body.rows.length - height));
		return body.rows.slice(top, top + height);
	}

	invalidate(): void {}
}

const HINTS: Record<MenuTab, string> = {
	denied: "a approve and tell the agent · x dismiss · tab next · esc close",
	granted: "x revoke · tab next · esc close",
	auto: "enter change · tab next · esc close",
	settings: "enter toggle · tab next · esc close",
};

export function framedMenu(view: PermissionsMenuView, theme: FrameTheme): Framed {
	return new Framed(view, "Permissions", theme);
}
