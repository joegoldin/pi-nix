// Markdown touches applied before pi renders a message.
//
// pi gives each extension one transformer slot, so the steps chain here in a
// fixed order. Every step leaves fenced code and inline code alone: a URL or a
// `> [!NOTE]` inside a code sample is an example, not something to render.

import type { UiConfig } from "./config.ts";

export interface TransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
}

const PROMPT_ICON = "❯";

type Kind = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";

const CALLOUT = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i;
// Glyphs that exist in every font pi is likely to meet, rather than emoji whose
// width terminals disagree on.
const CALLOUT_LABEL: Record<Kind, string> = {
	NOTE: "ⓘ Note",
	TIP: "✓ Tip",
	IMPORTANT: "! Important",
	WARNING: "⚠ Warning",
	CAUTION: "⚠ Caution",
};

const FENCE = /^\s*(```|~~~)/;

/** Run `fn` over each prose line, passing fenced blocks through untouched. */
function mapProse(markdown: string, fn: (lines: string[]) => string[]): string {
	const out: string[] = [];
	let prose: string[] = [];
	let fence: string | undefined;
	const flush = () => {
		if (prose.length) out.push(...fn(prose));
		prose = [];
	};
	for (const line of markdown.split("\n")) {
		const m = FENCE.exec(line);
		if (fence) {
			out.push(line);
			if (m && m[1] === fence) fence = undefined;
		} else if (m) {
			flush();
			fence = m[1];
			out.push(line);
		} else {
			prose.push(line);
		}
	}
	flush();
	return out.join("\n");
}

/**
 * GitHub callouts. The marker line becomes a bold label and the quote's own
 * lines stay a quote, so pi still draws its left rule and the callout keeps
 * its paragraph breaks.
 */
export function renderCallouts(markdown: string): string {
	return mapProse(markdown, (lines) =>
		lines.map((line) => {
			const m = CALLOUT.exec(line);
			if (!m) return line;
			const label = CALLOUT_LABEL[m[1].toUpperCase() as Kind];
			return m[2] ? `> **${label}** ${m[2]}` : `> **${label}**`;
		}),
	);
}

// Stops at whitespace, angle brackets and quotes; trailing punctuation is
// trimmed afterwards, because "see https://x.dev." means the URL, not the dot.
const URL = /(?<![<\w[])https?:\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?'"]+$/;

/** Drop trailing punctuation, and closing brackets the URL did not open. */
export function trimUrl(url: string): string {
	let t = url.replace(TRAILING, "");
	for (const [open, close] of [
		["(", ")"],
		["[", "]"],
	] as const) {
		while (t.endsWith(close) && t.split(open).length < t.split(close).length) {
			t = t.slice(0, -1).replace(TRAILING, "");
		}
	}
	return t;
}

/** Bare URLs become markdown links, which pi renders as clickable OSC 8 links. */
export function linkUrls(markdown: string): string {
	return mapProse(markdown, (lines) =>
		lines.map((line) =>
			line
				.split("`")
				.map((part, i) =>
					// Odd parts are inside inline code.
					i % 2 === 1
						? part
						: part.replace(URL, (raw, offset: number, whole: string) => {
								// Already the target of a link: [text](url) leaves "](" before it.
								if (whole.slice(Math.max(0, offset - 2), offset) === "](") return raw;
								const url = trimUrl(raw);
								return url ? `[${url}](${url})${raw.slice(url.length)}` : raw;
							}),
				)
				.join("`"),
		),
	);
}

export function transformMarkdown(markdown: string, context: TransformContext, config: UiConfig): string {
	if (context.messageType === "assistant-thinking" || markdown.trim() === "") return markdown;
	let out = markdown;
	if (config.admonitions) out = renderCallouts(out);
	if (config.linkUrls) out = linkUrls(out);
	if (context.messageType === "user" && config.promptIcon) out = `${PROMPT_ICON} ${out}`;
	return out;
}
