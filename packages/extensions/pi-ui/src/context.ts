// /context: where the context window is going.
//
// pi knows the total (ctx.getContextUsage) but not its parts, so the parts are
// estimated from the text pi would send, at four characters a token. The
// estimates are scaled to pi's total when it has one, so the bar adds up to
// the number in the header instead of disagreeing with it.

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UiTheme } from "./card.ts";

export interface Category {
	id: string;
	label: string;
	tokens: number;
	/** What the category holds, for the preview pane. */
	preview: string;
}

export interface ContextSources {
	systemPrompt: string;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Array<{ name: string; description: string }>;
	tools: Array<{ name: string; description?: string; parameters?: unknown }>;
	messages: Array<{ role: string; content: unknown }>;
	usedTokens: number | null;
	contextWindow: number;
}

export interface Breakdown {
	categories: Category[];
	used: number;
	window: number;
	/** True when `used` is pi's own count rather than the sum of estimates. */
	measured: boolean;
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

interface Part {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
}

function partsOf(content: unknown): Part[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Part[]) : [];
}

function textOfParts(parts: Part[]): string {
	return parts
		.map((p) => p.text ?? p.thinking ?? (p.type === "toolCall" ? `${p.name}(${JSON.stringify(p.arguments)})` : ""))
		.join("\n");
}

/**
 * Split the conversation into what the user wrote, what the model wrote, the
 * calls it made, and what those calls returned. Tool results are usually the
 * bulk of a long session, which is the thing /context exists to show.
 */
function messageBuckets(messages: ContextSources["messages"]) {
	const user: string[] = [];
	const assistant: string[] = [];
	const calls: string[] = [];
	const results: string[] = [];
	for (const m of messages) {
		const parts = partsOf(m.content);
		if (m.role === "user") user.push(textOfParts(parts));
		else if (m.role === "toolResult") results.push(textOfParts(parts));
		else if (m.role === "assistant") {
			assistant.push(textOfParts(parts.filter((p) => p.type !== "toolCall")));
			calls.push(textOfParts(parts.filter((p) => p.type === "toolCall")));
		} else user.push(textOfParts(parts));
	}
	return { user, assistant, calls, results };
}

export function computeBreakdown(src: ContextSources): Breakdown {
	const memory = src.contextFiles.map((f) => `# ${f.path}\n${f.content}`).join("\n\n");
	const skills = src.skills.map((s) => `${s.name}: ${s.description}`).join("\n");
	const tools = src.tools
		.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }))
		.join("\n");
	// The system prompt string already contains the memory and skill sections;
	// what remains after taking them out is pi's own instructions.
	const base = Math.max(0, estimateTokens(src.systemPrompt) - estimateTokens(memory) - estimateTokens(skills));
	const b = messageBuckets(src.messages);

	const raw: Category[] = [
		{ id: "system", label: "System prompt", tokens: base, preview: src.systemPrompt },
		{ id: "memory", label: "Memory", tokens: estimateTokens(memory), preview: memory },
		{ id: "skills", label: "Skills", tokens: estimateTokens(skills), preview: skills },
		{ id: "tools", label: "Tool definitions", tokens: estimateTokens(tools), preview: src.tools.map((t) => t.name).join("\n") },
		{ id: "user", label: "Your messages", tokens: estimateTokens(b.user.join("\n")), preview: b.user.join("\n\n───\n\n") },
		{ id: "assistant", label: "Model replies", tokens: estimateTokens(b.assistant.join("\n")), preview: b.assistant.join("\n\n───\n\n") },
		{ id: "calls", label: "Tool calls", tokens: estimateTokens(b.calls.join("\n")), preview: b.calls.join("\n") },
		{ id: "results", label: "Tool results", tokens: estimateTokens(b.results.join("\n")), preview: b.results.join("\n\n───\n\n") },
	];

	const estimated = raw.reduce((sum, c) => sum + c.tokens, 0);
	const measured = src.usedTokens !== null && src.usedTokens > 0;
	const used = measured ? (src.usedTokens as number) : estimated;
	const scale = measured && estimated > 0 ? used / estimated : 1;
	const categories = raw.map((c) => ({ ...c, tokens: Math.round(c.tokens * scale) }));
	categories.push({
		id: "free",
		label: "Free space",
		tokens: Math.max(0, src.contextWindow - used),
		preview: "",
	});
	return { categories, used, window: src.contextWindow, measured };
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

// Each category keeps one colour slot in the bar and the list, so the two read together.
const SLOTS = ["mdHeading", "accent", "syntaxKeyword", "syntaxFunction", "userMessageText", "success", "warning", "syntaxString", "dim"];

export function renderBar(b: Breakdown, width: number, theme: UiTheme): string {
	const total = Math.max(b.window, 1);
	let used = 0;
	let out = "";
	b.categories.forEach((c, i) => {
		const cells = i === b.categories.length - 1 ? width - used : Math.round((c.tokens / total) * width);
		const n = Math.max(0, Math.min(cells, width - used));
		used += n;
		out += theme.fg(SLOTS[i % SLOTS.length], (c.id === "free" ? "░" : "█").repeat(n));
	});
	return out;
}

/** The /context overlay: header, bar, category list, and a preview of the selected one. */
export class ContextView {
	private selected = 0;
	private previewing = false;
	private scroll = 0;

	constructor(
		private breakdown: Breakdown,
		private theme: UiTheme,
		private height: () => number,
		private done: () => void,
	) {}

	private rows(width: number): string[] {
		const { theme, breakdown: b } = this;
		const pct = ((b.used / Math.max(b.window, 1)) * 100).toFixed(1);
		const head = `${formatTokens(b.used)} / ${formatTokens(b.window)} tokens (${pct}%)${
			b.measured ? "" : theme.fg("muted", " estimated")
		}`;
		const rows = [head, renderBar(b, width, theme), ""];
		b.categories.forEach((c, i) => {
			const share = ((c.tokens / Math.max(b.window, 1)) * 100).toFixed(1).padStart(5);
			const mark = i === this.selected ? theme.fg("accent", "›") : " ";
			const swatch = theme.fg(SLOTS[i % SLOTS.length], "■");
			const label = i === this.selected ? theme.bold(c.label) : c.label;
			const label_w = 18;
			rows.push(
				`${mark} ${swatch} ${label}${" ".repeat(Math.max(1, label_w - visibleWidth(c.label)))}${formatTokens(c.tokens).padStart(7)}  ${theme.fg("muted", `${share}%`)}`,
			);
		});
		rows.push("", theme.fg("muted", "↑↓ select · enter preview · esc close"));
		return rows;
	}

	private previewRows(width: number): string[] {
		const c = this.breakdown.categories[this.selected];
		const body = c.preview ? wrapTextWithAnsi(c.preview, Math.max(1, width)) : [this.theme.fg("muted", "(empty)")];
		const room = Math.max(1, this.height() - 3);
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - room)));
		return [
			`${this.theme.bold(c.label)}  ${this.theme.fg("muted", `${formatTokens(c.tokens)} tokens`)}`,
			...body.slice(this.scroll, this.scroll + room),
			this.theme.fg("muted", `↑↓ scroll · ${this.scroll + 1}-${Math.min(body.length, this.scroll + room)} of ${body.length} · esc back`),
		];
	}

	render(width: number): string[] {
		const rows = this.previewing ? this.previewRows(width) : this.rows(width);
		return rows.map((r) => (visibleWidth(r) > width ? truncateToWidth(r, width, "…") : r));
	}

	handleInput(data: string): void {
		const last = this.breakdown.categories.length - 1;
		if (this.previewing) {
			if (matchesKey(data, "escape") || matchesKey(data, "left")) this.previewing = false;
			else if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, "down")) this.scroll++;
			else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - 10);
			else if (matchesKey(data, "pageDown")) this.scroll += 10;
			return;
		}
		if (matchesKey(data, "escape") || data === "q") this.done();
		else if (matchesKey(data, "up")) this.selected = this.selected === 0 ? last : this.selected - 1;
		else if (matchesKey(data, "down")) this.selected = this.selected === last ? 0 : this.selected + 1;
		else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
			this.previewing = true;
			this.scroll = 0;
		}
	}

	invalidate(): void {}
}
