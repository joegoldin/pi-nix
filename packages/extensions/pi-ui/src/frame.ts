// A bordered box around an overlay's content.
//
// pi composites an overlay line by line over the transcript, and a line only
// covers as many columns as it has. Content that ends early lets the
// transcript show through beside it, so every row here is padded to the full
// width and closed with a rule.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UiTheme } from "./card.ts";

interface Inner {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
}

export class Framed {
	constructor(
		private inner: Inner,
		private title: string,
		private theme: UiTheme,
	) {}

	render(width: number): string[] {
		const w = Math.max(6, width);
		const innerW = w - 4;
		const rule = (s: string) => this.theme.fg("border", s);
		const label = ` ${this.title} `;
		const top = `${rule("╭─")}${this.theme.bold(label)}${rule(`${"─".repeat(Math.max(0, w - 3 - visibleWidth(label)))}╮`)}`;
		const rows = this.inner.render(innerW).map((line) => {
			const fitted = visibleWidth(line) > innerW ? truncateToWidth(line, innerW, "…") : line;
			return `${rule("│")} ${fitted}${" ".repeat(Math.max(0, innerW - visibleWidth(fitted)))} ${rule("│")}`;
		});
		return [top, ...rows, rule(`╰${"─".repeat(w - 2)}╯`)];
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}
