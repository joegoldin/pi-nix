// The ask before a classifier block stands: the call, the classifier's reason,
// Allow or Deny, and a countdown. Drawn as pi-custom draws its dialogs, in the
// editor's place and framed. No answer by the deadline keeps the block. Asked
// only in the interactive terminal UI.

import { beginPermissionStatus } from "./program-status.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { callLabel } from "./call-label.ts";
import { type BlockAnswer, BlockPrompt } from "./block-prompt-state.ts";
import { Framed, type FrameTheme } from "./frame.ts";

/** Under this many seconds the countdown turns from dim to a warning. */
const URGENT_SECONDS = 10;
const TICK_MS = 250;

/** pi's theme has bold; the prompt marks its title and highlighted answer with it. */
interface BlockTheme extends FrameTheme {
	bold(text: string): string;
}

export interface BlockAsk {
	title?: string;
	/** A later retry must use a rechecked ledger scope, never a one-shot execution bypass. */
	scopeOnly?: boolean;
	toolName: string;
	input: unknown;
	reason: string;
	timeoutSeconds: number;
	/** Displayed reusable scope; absent when this call cannot safely be generalized. */
	scope?: string;
	/** Only the displayed directory grant persists, scoped to this canonical launch folder. */
	futureScope?: string;
}

export class BlockPromptView {
	private expanded = false;
	private top = 0;
	private maxTop = 0;

	constructor(
		private readonly prompt: BlockPrompt,
		private readonly ask: BlockAsk,
		private readonly theme: BlockTheme,
		private readonly height: () => number = () => 20,
	) {}

	render(width: number): string[] {
		const { theme, prompt, ask } = this;
		if (this.expanded) return this.explanation(width);
		const { title, target } = callLabel(ask.toolName, ask.input);
		const lines = [`${theme.fg("warning", "●")} ${theme.bold(title)}${target ? theme.fg("muted", `(${target})`) : ""}`];
		const wrapped = wrapTextWithAnsi(ask.reason, Math.max(1, width - 5));
		wrapped.forEach((part, i) => lines.push(theme.fg("muted", `${i === 0 ? "  ⎿  " : "     "}${part}`)));
		lines.push("");
		if (ask.scope) lines.push(...wrapTextWithAnsi(`Remembered scope: ${ask.scope}`, Math.max(1, width)).map((line) => theme.fg("muted", line)), "");
		prompt.choices.forEach((choice, i) => {
			const here = i === prompt.cursor;
			const label = `${choice.label} ${theme.fg("dim", `(${choice.key})`)}`;
			lines.push(here ? `${theme.fg("accent", "❯ ")}${theme.bold(label)}` : `  ${label}`);
			if (choice.answer === "allow-future" && ask.futureScope)
				lines.push(...wrapTextWithAnsi(`    ${ask.futureScope}`, Math.max(1, width)).map(line => theme.fg("dim", line)));
		});
		lines.push("");
		const left = prompt.secondsLeft();
		lines.push(theme.fg(!prompt.explaining && left < URGENT_SECONDS ? "warning" : "dim", prompt.explaining ? "Timer stopped — waiting for your decision" : `No answer in ${left}s keeps the block`));
		lines.push(theme.fg("dim", `${ask.scope ? "y allow scope · " : ""}${ask.futureScope ? "f allow future · " : ""}${ask.scopeOnly ? "" : "Y allow once · "}n or Esc deny · e explain/stop timer`));
		return lines;
	}

	private explanation(width: number): string[] {
		const { ask, theme } = this;
		const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width));
		const input = ask.input && typeof ask.input === "object" ? ask.input as Record<string, unknown> : {};
		const rows = [
			theme.bold("Why approval is needed"),
			...wrap(ask.reason),
			"",
			...(typeof input.command === "string" ? [theme.bold("Exact command (not executed)"), ...wrap(input.command), ""] : []),
			theme.bold("Full tool input"),
			...wrap(JSON.stringify(ask.input ?? null, null, 2)),
		];
		const available = Math.max(1, this.height() - 6);
		this.maxTop = Math.max(0, rows.length - available);
		this.top = Math.min(this.top, this.maxTop);
		return [
			theme.bold(`Explain: ${ask.toolName}`),
			theme.fg("dim", "Timer stopped — no command runs until you approve"),
			...rows.slice(this.top, this.top + available),
			theme.fg("dim", `↑/↓ scroll · e or Esc back · ${this.top + 1}–${Math.min(rows.length, this.top + available)}/${rows.length}`),
		];
	}

	handleInput(data: string): void {
		const { prompt } = this;
		if (this.expanded) {
			if (matchesKey(data, "escape") || data === "e") this.expanded = false;
			else if (matchesKey(data, "up") || data === "k") this.top = Math.max(0, this.top - 1);
			else if (matchesKey(data, "down") || data === "j") this.top = Math.min(this.maxTop, this.top + 1);
			else if (data === "n") prompt.cancel();
			return;
		}
		if (data === "e" && !prompt.result) {
			prompt.press("e");
			this.expanded = true;
			this.top = 0;
		} else if (matchesKey(data, "escape")) prompt.cancel();
		else if (matchesKey(data, "up")) prompt.move(-1);
		else if (matchesKey(data, "down")) prompt.move(1);
		else if (matchesKey(data, "enter")) prompt.confirm();
		else if (data.length === 1) prompt.press(data);
	}

	invalidate(): void {}
}

/**
 * Ask in the terminal UI, the only place it is asked (see auto/extension.ts).
 * Resolves with the answer, "timeout" when none came in time.
 */
export async function askBeforeBlock(ctx: ExtensionContext, ask: BlockAsk): Promise<BlockAnswer> {
	const timeoutMs = ask.timeoutSeconds * 1000;
	// The terminal bell, as pi-custom's questions ring it: the call is waiting.
	if (process.stdout.isTTY) process.stdout.write("\x07");
	const finishStatus = beginPermissionStatus(ctx.ui);
	try {
		return await ctx.ui.custom<BlockAnswer>((tui, theme, _keybindings, done) => {
			const prompt = new BlockPrompt(timeoutMs, Date.now, !!ask.scope, ask.scopeOnly, !!ask.futureScope);
			const view = new Framed(new BlockPromptView(prompt, ask, theme as never, () => process.stdout.rows || 24), ask.title ?? "Auto mode would block this", theme as never);
			let finished = false;
			const onAbort = () => {
				prompt.cancel();
				settle();
			};
			const settle = () => {
				if (finished || !prompt.result) return;
				finished = true;
				clearInterval(timer);
				ctx.signal?.removeEventListener("abort", onAbort);
				done(prompt.result);
			};
			// Repaints the countdown, and settles when it runs out.
			const timer = setInterval(() => {
				prompt.tick();
				tui.requestRender();
				settle();
			}, TICK_MS);
			// The turn interrupted (Esc to steer, or a plain cancel) ends the ask.
			ctx.signal?.addEventListener("abort", onAbort, { once: true });
			return {
				render: (width: number) => view.render(width),
				invalidate: () => view.invalidate(),
				handleInput: (data: string) => {
					view.handleInput(data);
					tui.requestRender();
					settle();
				},
				dispose: () => clearInterval(timer),
			};
		});
	} finally { finishStatus(); }
}
