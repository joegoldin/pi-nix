// The /permissions menu: what was blocked, to approve or dismiss, and what you
// have approved, to revoke. Drawn as pi-custom draws /context: framed, in the
// editor's place, a list with the selected row opened up.

import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Denial, Grant } from "../denials.ts";
import { callLabel, shortReason } from "./call-label.ts";
import { Framed, type FrameTheme } from "./frame.ts";
import { ago, type MenuEffect, type MenuKey, PermissionsMenu } from "./menu-state.ts";

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
		if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) return "tab";
		if (matchesKey(data, "enter") || data === "a") return "approve";
		if (data === "x" || data === "d") return "remove";
		return undefined;
	}

	render(width: number): string[] {
		const { menu, theme } = this;
		const denied = menu.denied();
		const granted = menu.granted();
		const chip = (text: string, active: boolean) =>
			active ? (theme.bg ? theme.bg("selectedBg", ` ${text} `) : theme.fg("accent", theme.bold(` ${text} `))) : theme.fg("muted", ` ${text} `);
		const lines = [`${chip(`Denied (${denied.length})`, menu.tab === "denied")} ${chip(`Allowed (${granted.length})`, menu.tab === "granted")}`, ""];
		const body = menu.tab === "denied" ? this.deniedRows(denied, width) : this.grantedRows(granted, width);
		lines.push(...this.window(body, Math.max(4, this.height() - 4)));
		lines.push("");
		lines.push(
			theme.fg(
				"dim",
				menu.tab === "denied"
					? "a approve and tell the agent · x dismiss · tab allowed · esc close"
					: "x revoke · tab denied · esc close",
			),
		);
		return lines;
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

export function framedMenu(view: PermissionsMenuView, theme: FrameTheme): Framed {
	return new Framed(view, "Permissions", theme);
}
