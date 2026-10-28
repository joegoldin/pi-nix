import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export interface Turn {
	question: string;
	answer?: string;
	error?: string;
}

export interface Thread {
	id: string;
	sessionId: string;
	turns: Turn[];
	busy?: AbortController;
	draft?: string;
}

/** The latest exchange, framed so the main model reads it as discussion, not as done work. */
export function bringBackDraft(turn: Turn): string {
	return discussionDraft(
		`User:\n${turn.question}\n\nAssistant:\n${turn.answer ?? ""}`,
	);
}

export function bringBackThreadDraft(turns: readonly Turn[]): string {
	return discussionDraft(
		turns
			.map(
				(turn) =>
					`User:\n${turn.question}\n\nAssistant:\n${turn.answer ?? (turn.error ? `[No answer: ${turn.error}]` : "[No completed answer.]")}`,
			)
			.join("\n\n"),
	);
}

function discussionDraft(content: string): string {
	return `The following context was brought back from a /btw side discussion.
Treat it as discussion context, not as work already completed.

<btw_context>
${content}
</btw_context>`;
}

export class BtwView {
	private input = new Input();
	private get busy(): AbortController | undefined {
		return this.thread.busy;
	}
	private set busy(value: AbortController | undefined) {
		this.thread.busy = value;
	}
	private status = "";
	private top = 0;
	private maxTop = 0;
	private pageSize = 1;
	private followTail = true;

	constructor(
		private thread: Thread,
		private theme: {
			fg(slot: string, text: string): string;
			bold(text: string): string;
		},
		private ask: (question: string, signal: AbortSignal) => Promise<void>,
		private bringBack: (all: boolean) => void,
		private close: () => void,
		private rerender: () => void,
		private height: () => number = () => 16,
		private actions?: {
			fork(): void;
			fresh(): void;
			switch(): void;
			mode(): void;
			stop(): void;
		},
	) {
		this.input.focused = true;
		this.input.setValue(thread.draft ?? "");
	}

	start(question: string): void {
		if (this.busy) return;
		this.followTail = true;
		const controller = new AbortController();
		this.busy = controller;
		this.status = "Answering…";
		this.rerender();
		void this.ask(question, controller.signal).finally(() => {
			if (this.busy === controller) this.busy = undefined;
			this.status = "";
			this.rerender();
		});
	}

	handleInput(data: string): void {
		for (const [key, action] of [
			["alt+f", "fork"],
			["alt+n", "fresh"],
			["alt+s", "switch"],
			["alt+t", "mode"],
			["alt+x", "stop"],
		] as const) {
			if (this.actions && matchesKey(data, key)) {
				this.actions[action]();
				return;
			}
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "ctrl+shift+r")) {
			if (this.thread.turns.length) {
				this.busy?.abort();
				this.bringBack(true);
			}
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			if (this.thread.turns.some((t) => t.answer)) {
				this.busy?.abort();
				this.bringBack(false);
			}
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scroll(-this.pageSize);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scroll(this.pageSize);
			return;
		}
		if (matchesKey(data, "ctrl+home")) {
			this.scroll(-this.maxTop);
			return;
		}
		if (matchesKey(data, "ctrl+end")) {
			this.scroll(this.maxTop);
			return;
		}
		if (matchesKey(data, "enter")) {
			const question = this.input.getValue().trim();
			if (!question) {
				this.status = "Question cannot be empty";
				return;
			}
			if (this.busy) return;
			this.input.setValue("");
			this.thread.draft = "";
			this.start(question);
			return;
		}
		this.input.handleInput(data);
		this.thread.draft = this.input.getValue();
	}

	private scroll(delta: number): void {
		this.top = Math.max(0, Math.min(this.maxTop, this.top + delta));
		this.followTail = this.top === this.maxTop;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return;
		this.scroll((event.wheelDelta ?? 0) * 3);
		return { handled: true, render: true };
	}

	render(width: number): string[] {
		const { theme } = this;
		const transcript: string[] = [];
		for (const turn of this.thread.turns) {
			transcript.push(
				...wrapTextWithAnsi(turn.question, Math.max(1, width - 2)).map(
					(line, i) => (i ? "  " : theme.fg("accent", "❯ ")) + theme.bold(line),
				),
				"",
			);
			if (turn.error)
				transcript.push(
					...wrapTextWithAnsi(`Error: ${turn.error}`, Math.max(1, width)).map(
						(line) => theme.fg("error", line),
					),
					"",
				);
			else if (turn.answer !== undefined)
				transcript.push(
					...new Markdown(turn.answer, 0, 0, getMarkdownTheme()).render(width),
					"",
				);
		}
		const height = Math.max(1, Math.floor(this.height()));
		// Keep the composer separate and readable; only history scrolls.
		const input = this.input.render(width)[0] ?? "";
		const status = this.busy ? "Answering…" : this.status;
		const hints = [
			"Enter ask · Ctrl+r latest · Ctrl+Shift+r all",
			this.actions
				? "Esc/Ctrl+c main · Alt+s switch · Alt+f fork · Alt+n new · Alt+t mode · Alt+x stop"
				: "Esc close",
		].flatMap(text => wrapTextWithAnsi(text, Math.max(1, width)));
		const footer = height < 4 ? [input] : [
			theme.fg("border", "─".repeat(Math.max(1, width))),
			...(status ? [theme.fg("muted", status)] : []),
			input,
			"",
			...hints.slice(0, Math.max(0, height - (status ? 6 : 5))).map(line => theme.fg("dim", line)),
		];
		const padding = height >= 4 ? 1 : 0;
		const historyHeight = Math.max(0, height - footer.length - padding);
		this.pageSize = Math.max(1, historyHeight);
		this.maxTop = Math.max(0, transcript.length - historyHeight);
		this.top = this.followTail ? this.maxTop : Math.min(this.top, this.maxTop);
		const history = transcript.slice(this.top, this.top + historyHeight);
		if (height >= 4 && historyHeight > 0 && this.maxTop > 0) {
			const position = truncateToWidth(` ${this.top + 1}–${this.top + history.length}/${transcript.length} · Wheel/PgUp/PgDn `, width, "");
			footer[0] = theme.fg("muted", position) + theme.fg("border", "─".repeat(Math.max(0, width - visibleWidth(position))));
		}
		return [
			...Array(padding).fill(""),
			...history,
			...Array(Math.max(0, historyHeight - history.length)).fill(""),
			...footer,
		].slice(-height).map((line) =>
			visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line,
		);
	}

	invalidate(): void {}
}
