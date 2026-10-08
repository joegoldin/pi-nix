// A bordered box around a dialog, drawn as pi-custom draws its own (pi-custom's
// src/ui/frame.ts), so a permission prompt looks like the rest of this setup's
// dialogs.
//
// pi composites a dialog line by line over the transcript, and a line only
// covers as many columns as it has. Content that ends early lets the
// transcript show through beside it, so every row here is padded to the full
// width and closed with a rule.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface FrameTheme {
	fg(slot: string, text: string): string;
	/** Absent from some themes (and test doubles); the title is then plain. */
	bold?(text: string): string;
}

interface Inner {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

export class Framed {
	constructor(
		private inner: Inner,
		private title: string,
		private theme: FrameTheme,
	) {}

	render(width: number): string[] {
		const w = Math.max(6, width);
		const innerW = w - 4;
		const rule = (s: string) => this.theme.fg("border", s);
		const label = ` ${this.title} `;
		const top = `${rule("╭─")}${this.theme.bold ? this.theme.bold(label) : label}${rule(`${"─".repeat(Math.max(0, w - 3 - visibleWidth(label)))}╮`)}`;
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

	dispose(): void {
		this.inner.dispose?.();
	}
}
