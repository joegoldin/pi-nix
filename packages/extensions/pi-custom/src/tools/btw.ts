// /btw: a side question answered from the conversation so far, without
// adding anything to it.
//
// The side model gets a snapshot of the conversation (its text and tool
// calls, the last 40k characters) and the question, and no tools. Follow-ups
// continue the same thread. Nothing reaches the main conversation unless you
// bring it back with ctrl+r, which puts the latest exchange into your editor
// as a draft for you to send or not. Ctrl+Shift+R brings the whole thread.
// Threads last for the session; their viewport stays bounded above the editor.

import { randomUUID } from "node:crypto";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { Input, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Framed } from "../ui/frame.ts";

const CONTEXT_CHARS = 40_000;

const SYSTEM_PROMPT = `You answer quick side questions for a coding-agent user.

Use the provided conversation context only as background. Answer the user's side question directly and concisely. Do not claim to have changed files, run tools, or affected the main task. If the context is insufficient, say what is unknown and give the best next step.`;

interface Turn {
	question: string;
	answer?: string;
	/** The full assistant message, replayed as-is into follow-up requests. */
	response?: unknown;
	error?: string;
}

interface Thread {
	id: string;
	sessionId: string;
	context: string;
	turns: Turn[];
	updatedAt: number;
}

interface EntryLike {
	type?: string;
	message?: { role?: string; content?: unknown; stopReason?: string };
}

/** The conversation as plain text for the side model: what was said and what tools were called. */
export function conversationContext(entries: EntryLike[]): string {
	const blocks: string[] = [];
	for (const e of entries) {
		const m = e.message;
		if (e.type !== "message" || (m?.role !== "user" && m?.role !== "assistant")) continue;
		const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
		const text = (parts as Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>)
			.map((p) => (p.type === "text" ? (p.text ?? "").trim() : p.type === "toolCall" ? `Tool call: ${p.name}(${JSON.stringify(p.arguments ?? {})})` : ""))
			.filter(Boolean)
			.join("\n");
		if (!text) continue;
		const who = m.role === "user" ? "User" : m.stopReason && m.stopReason !== "stop" ? `Assistant (${m.stopReason})` : "Assistant";
		blocks.push(`${who}: ${text}`);
	}
	const all = blocks.join("\n\n");
	return all.length > CONTEXT_CHARS
		? `[Earlier context omitted; showing the last ${CONTEXT_CHARS} characters.]\n${all.slice(all.length - CONTEXT_CHARS)}`
		: all;
}

export function firstMessage(question: string, context: string): string {
	return `Answer this side question without modifying the main conversation.

<side_question>
${question}
</side_question>

<conversation_context>
${context || "No prior conversation context was available."}
</conversation_context>`;
}

export function followUpMessage(question: string): string {
	return `Continue the same side conversation.

<side_question>
${question}
</side_question>`;
}

/** The latest exchange, framed so the main model reads it as discussion, not as done work. */
export function bringBackDraft(turn: Turn): string {
	return discussionDraft(`User:\n${turn.question}\n\nAssistant:\n${turn.answer ?? ""}`);
}

export function bringBackThreadDraft(turns: readonly Turn[]): string {
	return discussionDraft(turns.map((turn) => `User:\n${turn.question}\n\nAssistant:\n${turn.answer ?? (turn.error ? `[No answer: ${turn.error}]` : "[No completed answer.]")}`).join("\n\n"));
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
	private busy: AbortController | undefined;
	private status = "";
	private top = 0;
	private maxTop = 0;
	private pageSize = 1;
	private followTail = true;

	constructor(
		private thread: Thread,
		private theme: { fg(slot: string, text: string): string; bold(text: string): string },
		private ask: (question: string, signal: AbortSignal) => Promise<void>,
		private bringBack: (all: boolean) => void,
		private close: () => void,
		private rerender: () => void,
		private height: () => number = () => 16,
	) {
		this.input.focused = true;
	}

	start(question: string): void {
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
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.busy?.abort();
			this.close();
			return;
		}
		if (matchesKey(data, "ctrl+shift+r")) {
			if (this.thread.turns.length) { this.busy?.abort(); this.bringBack(true); }
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			if (this.thread.turns.some((t) => t.answer)) { this.busy?.abort(); this.bringBack(false); }
			return;
		}
		if (matchesKey(data, "pageUp")) { this.scroll(-this.pageSize); return; }
		if (matchesKey(data, "pageDown")) { this.scroll(this.pageSize); return; }
		if (matchesKey(data, "ctrl+home")) { this.scroll(-this.maxTop); return; }
		if (matchesKey(data, "ctrl+end")) { this.scroll(this.maxTop); return; }
		if (matchesKey(data, "enter")) {
			const question = this.input.getValue().trim();
			if (!question) {
				this.status = "Question cannot be empty";
				return;
			}
			if (this.busy) return;
			this.input.setValue("");
			this.start(question);
			return;
		}
		this.input.handleInput(data);
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
			transcript.push(...wrapTextWithAnsi(turn.question, Math.max(1, width - 2)).map((line, i) =>
				(i ? "  " : theme.fg("accent", "❯ ")) + theme.bold(line)), "");
			if (turn.error) transcript.push(...wrapTextWithAnsi(`Error: ${turn.error}`, Math.max(1, width)).map((line) => theme.fg("error", line)), "");
			else if (turn.answer !== undefined) transcript.push(...new Markdown(turn.answer, 0, 0, getMarkdownTheme()).render(width), "");
		}
		const height = Math.max(1, Math.floor(this.height()));
		const historyHeight = Math.max(0, height - 4);
		this.pageSize = Math.max(1, historyHeight);
		this.maxTop = Math.max(0, transcript.length - historyHeight);
		this.top = this.followTail ? this.maxTop : Math.min(this.top, this.maxTop);
		// The composer is never part of the scrolling transcript, even on resize.
		const input = this.input.render(width)[0] ?? "";
		const status = theme.fg("muted", this.status);
		const keys = theme.fg("dim", "Enter ask · Ctrl+r latest · Ctrl+Shift+r all");
		const navigation = theme.fg("dim", "Esc close");
		const footer = height >= 4 ? [status, input, keys, navigation] : [input, keys, navigation].slice(0, height);
		return [...transcript.slice(this.top, this.top + historyHeight), ...footer]
			.map((line) => visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line);
	}

	invalidate(): void {}
}

export function registerBtw(pi: ExtensionAPI): void {
	const threads = new Map<string, Thread>();

	async function answer(ctx: ExtensionCommandContext, thread: Thread, question: string, signal: AbortSignal): Promise<void> {
		const model = ctx.model;
		const turn: Turn = { question };
		thread.turns.push(turn);
		thread.updatedAt = Date.now();
		const discard = () => {
			// A closed thread may already have been resumed before cancellation settles.
			const index = thread.turns.indexOf(turn);
			if (index >= 0) thread.turns.splice(index, 1);
		};
		if (!model) {
			turn.error = "No model is selected.";
			return;
		}
		const answered = thread.turns.filter((t) => t.response && !t.error);
		const messages: unknown[] = [];
		answered.forEach((t, i) => {
			messages.push({ role: "user", content: i === 0 ? firstMessage(t.question, thread.context) : followUpMessage(t.question), timestamp: Date.now() });
			messages.push(t.response);
		});
		messages.push({
			role: "user",
			content: answered.length === 0 ? firstMessage(question, thread.context) : followUpMessage(question),
			timestamp: Date.now(),
		});
		const level = clampThinkingLevel(model, pi.getThinkingLevel() as never);
		try {
			const response = (await ctx.modelRegistry
				.streamSimple(model, { systemPrompt: SYSTEM_PROMPT, messages: messages as never }, {
					signal,
					// Its own session id, so side requests never share the main thread's cache or routing.
					sessionId: thread.id,
					...(level !== "off" ? { reasoning: level as never } : {}),
				})
				.result()) as { stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> };
			if (signal.aborted || response.stopReason === "aborted") {
				discard();
				return;
			}
			if (response.stopReason === "error") {
				turn.error = response.errorMessage ?? "The side model returned an error.";
				return;
			}
			turn.answer = (response.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n") || "No response received.";
			turn.response = response;
		} catch (err) {
			if (signal.aborted) discard();
			else turn.error = (err as Error).message;
		}
	}

	async function open(ctx: ExtensionCommandContext, thread: Thread, question: string | undefined): Promise<void> {
		// Written after the side thread closes: while it is drawn in the
		// editor's place, pi restores the editor's earlier text on close and
		// would overwrite a draft set before then.
		let draft: string | undefined;
		let importedAll = false;
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const view: BtwView = new BtwView(
				thread,
				theme,
				(q, signal) => answer(ctx, thread, q, signal),
				(all) => {
					const latest = [...thread.turns].reverse().find((t) => t.answer);
					if (!all && !latest) return;
					importedAll = all;
					draft = all ? bringBackThreadDraft(thread.turns) : bringBackDraft(latest!);
					done();
				},
				() => done(),
				() => tui.requestRender(),
				() => Math.max(1, Math.min(18, Math.floor(tui.terminal.rows * 0.45)) - 2),
			);
			if (question) view.start(question);
			const framed = new Framed(view, "btw · side thread", theme as never);
			return {
				render: (w: number) => framed.render(w),
				invalidate: () => framed.invalidate(),
				handleMouse: (event: TuiMouseEvent) => view.handleMouse(event),
				handleInput: (data: string) => {
					framed.handleInput(data);
					tui.requestRender();
				},
			};
		});
		if (draft) {
			const current = ctx.ui.getEditorText();
			ctx.ui.setEditorText(current.trim() ? `${current}\n\n${draft}` : draft);
			ctx.ui.notify(importedAll ? "Brought the full /btw thread into your prompt." : "Brought the latest /btw answer into your prompt.", "info");
		}
	}

	pi.registerCommand("btw", {
		description: "Ask a quick side question without adding it to the main conversation",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive TUI mode", "error");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const fresh = (): Thread => ({
				id: `btw-${randomUUID()}`,
				sessionId,
				context: conversationContext(ctx.sessionManager.getBranch() as EntryLike[]),
				turns: [],
				updatedAt: Date.now(),
			});
			const question = args.trim();
			if (question) {
				const thread = fresh();
				threads.set(thread.id, thread);
				await open(ctx, thread, question);
				return;
			}
			const resumable = [...threads.values()]
				.filter((t) => t.sessionId === sessionId && t.turns.length > 0)
				.sort((a, b) => b.updatedAt - a.updatedAt);
			const labels = ["Start side thread", ...resumable.map((t) => `Resume: ${t.turns[0].question.slice(0, 70)}`)];
			const picked = resumable.length ? await ctx.ui.select("btw", labels) : labels[0];
			if (!picked) return;
			const index = labels.indexOf(picked);
			const thread = index <= 0 ? fresh() : resumable[index - 1];
			threads.set(thread.id, thread);
			await open(ctx, thread, undefined);
		},
	});
}
