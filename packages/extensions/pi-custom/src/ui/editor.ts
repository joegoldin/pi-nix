// The prompt box and the working shimmer.
//
// The box is pi's own editor with rounded corners, side rules, and a ❯ in the
// left padding of the first line, coloured by the thinking level so the level
// is visible where you type. It subclasses pi's CustomEditor rather than
// wrapping it, so every app keybinding and the embedded working row keep
// working unchanged.
//
// The shimmer replaces pi's spinner while the agent runs: a spinner glyph and
// "Working…" with a brighter band sweeping across it. pi renders indicator
// frames verbatim, so each frame is pre-coloured here.

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { UiTheme } from "./card.ts";

const PROMPT_ICON = "❯";
// One space either side of the icon.
const PROMPT_WIDTH = 3;

type Colour = (text: string) => string;

/** pi's CustomEditor, as a constructor; taken as a parameter so tests need no live pi. */
export type EditorBase = new (...args: any[]) => {
	render(width: number): string[];
	getPaddingX(): number;
	setPaddingX(padding: number): void;
	// Protected in pi's Editor; declared here so the subclass can override and
	// call them. Overriding as public is allowed and changes nothing for pi.
	renderTopBorder(width: number, hiddenLineCount: number): string;
	renderBottomBorder(width: number, hiddenLineCount: number): string;
	borderColor: Colour;
};

export function createPromptEditor(Base: EditorBase, promptColour: () => Colour): EditorBase {
	class PromptEditor extends Base {
		private userPadding = 0;
		private scrolled = false;
		private topBorder = "";
		private bottomBorder = "";

		constructor(...args: any[]) {
			const [tui, theme, keybindings, options] = args;
			super(tui, theme, keybindings, { ...(options ?? {}), embedWorkingStatus: true });
			this.userPadding = super.getPaddingX();
			super.setPaddingX(this.userPadding + this.promptWidth());
		}

		/** The icon's columns, plus one at zero padding: the side rule takes column 0. */
		private promptWidth(): number {
			return PROMPT_WIDTH + (this.userPadding === 0 ? 1 : 0);
		}

		override getPaddingX(): number {
			return this.userPadding;
		}

		override setPaddingX(padding: number): void {
			this.userPadding = Math.max(0, padding);
			super.setPaddingX(this.userPadding + this.promptWidth());
		}

		override renderTopBorder(width: number, hiddenLineCount: number): string {
			this.scrolled = hiddenLineCount > 0;
			this.topBorder = this.round(super.renderTopBorder(width, hiddenLineCount), width, "╭", "╮");
			return this.topBorder;
		}

		override renderBottomBorder(width: number, hiddenLineCount: number): string {
			this.bottomBorder = this.round(super.renderBottomBorder(width, hiddenLineCount), width, "╰", "╯");
			return this.bottomBorder;
		}

		private round(line: string, width: number, left: string, right: string): string {
			if (width < 2 || visibleWidth(line) !== width) return line;
			return `${this.borderColor(left)}${sliceByColumn(line, 1, width - 2, true)}${this.borderColor(right)}`;
		}

		override render(width: number): string[] {
			this.topBorder = "";
			this.bottomBorder = "";
			const lines = super.render(width);
			const top = this.topBorder ? lines.indexOf(this.topBorder) : -1;
			const bottom = this.bottomBorder ? lines.lastIndexOf(this.bottomBorder) : -1;
			if (top < 0 || bottom <= top) return lines;

			// The icon goes in the padding of the first text row, and only when the
			// view is not scrolled: a scrolled box's first row is not the start of
			// the prompt.
			const first = top + 1;
			const pad = this.userPadding + this.promptWidth();
			if (!this.scrolled && first < bottom && lines[first]?.startsWith(" ".repeat(pad))) {
				const at = pad - PROMPT_WIDTH;
				lines[first] = `${lines[first].slice(0, at)} ${promptColour()(PROMPT_ICON)} ${lines[first].slice(pad)}`;
			}

			// Side rules on every full-width text row between the borders.
			for (let i = first; i < bottom; i++) {
				const line = lines[i];
				if (!line || visibleWidth(line) !== width || !line.startsWith(" ") || !line.endsWith(" ")) continue;
				lines[i] = `${this.borderColor("│")}${line.slice(1, -1)}${this.borderColor("│")}`;
			}
			return lines;
		}
	}
	return PromptEditor;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAND = 3;

// Theme slots that read as distinct accents. Taking them from the theme rather
// than fixing RGB values keeps the accents in the terminal's own palette.
const ACCENTS = [
	"accent",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"success",
	"warning",
	"mdHeading",
];

/**
 * The accent slot for a session: stable for its whole life, and usually
 * different between two sessions side by side, so a glance at the working
 * shimmer says which window is which.
 */
export function sessionAccent(sessionId: string): string {
	let h = 5381;
	for (let i = 0; i < sessionId.length; i++) h = ((h << 5) + h + sessionId.charCodeAt(i)) >>> 0;
	return ACCENTS[h % ACCENTS.length];
}

/**
 * One frame per band position, the band sweeping the label left to right and
 * running off the end before wrapping, so the sweep reads as motion rather
 * than as a stutter at the edges.
 */
export function shimmerFrames(label: string, theme: UiTheme, accent = "accent"): string[] {
	const chars = [...label];
	const frames: string[] = [];
	const positions = chars.length + BAND * 2;
	for (let p = 0; p < positions; p++) {
		const centre = p - BAND;
		const text = chars
			.map((ch, i) => {
				const d = Math.abs(i - centre);
				return d === 0 ? theme.bold(theme.fg(accent, ch)) : d < BAND ? theme.fg(accent, ch) : theme.fg("muted", ch);
			})
			.join("");
		frames.push(`${theme.fg(accent, SPINNER[p % SPINNER.length])} ${text}`);
	}
	return frames;
}
