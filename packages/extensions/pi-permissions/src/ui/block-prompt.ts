// The ask before a classifier block stands: the call, the classifier's reason,
// Allow or Deny, and a countdown. Drawn as pi-custom draws its dialogs, in the
// editor's place and framed. No answer by the deadline keeps the block. Asked
// only in the interactive terminal UI.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { callLabel } from "./call-label.ts";
import { BLOCK_CHOICES, type BlockAnswer, BlockPrompt } from "./block-prompt-state.ts";
import { Framed, type FrameTheme } from "./frame.ts";

/** Under this many seconds the countdown turns from dim to a warning. */
const URGENT_SECONDS = 10;
const TICK_MS = 250;

/** pi's theme has bold; the prompt marks its title and highlighted answer with it. */
interface BlockTheme extends FrameTheme {
	bold(text: string): string;
}

export interface BlockAsk {
	toolName: string;
	input: unknown;
	reason: string;
	timeoutSeconds: number;
}

export class BlockPromptView {
	constructor(
		private readonly prompt: BlockPrompt,
		private readonly ask: BlockAsk,
		private readonly theme: BlockTheme,
	) {}

	render(width: number): string[] {
		const { theme, prompt, ask } = this;
		const { title, target } = callLabel(ask.toolName, ask.input);
		const lines = [`${theme.fg("warning", "●")} ${theme.bold(title)}${target ? theme.fg("muted", `(${target})`) : ""}`];
		const wrapped = wrapTextWithAnsi(ask.reason, Math.max(1, width - 5));
		wrapped.forEach((part, i) => lines.push(theme.fg("muted", `${i === 0 ? "  ⎿  " : "     "}${part}`)));
		lines.push("");
		BLOCK_CHOICES.forEach((choice, i) => {
			const here = i === prompt.cursor;
			const label = `${choice.label} ${theme.fg("dim", `(${choice.key})`)}`;
			lines.push(here ? `${theme.fg("accent", "❯ ")}${theme.bold(label)}` : `  ${label}`);
		});
		lines.push("");
		const left = prompt.secondsLeft();
		lines.push(theme.fg(left < URGENT_SECONDS ? "warning" : "dim", `No answer in ${left}s keeps the block`));
		lines.push(theme.fg("dim", "Enter select · ↑/↓ · y allow · n or Esc deny"));
		return lines;
	}

	handleInput(data: string): void {
		const { prompt } = this;
		if (matchesKey(data, "escape")) prompt.cancel();
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
	return ctx.ui.custom<BlockAnswer>((tui, theme, _keybindings, done) => {
		const prompt = new BlockPrompt(timeoutMs);
		const view = new Framed(new BlockPromptView(prompt, ask, theme as never), "Auto mode would block this", theme as never);
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
}
