// How an inbound peer message is drawn: a rounded box headed by who sent it.
//
// Collapsed (the default) it shows one line of the body and the reply hint;
// ctrl+o expands it to the whole body. Messages recorded by pi-intercom carry
// a SessionInfo as `from` instead of a PeerRef; both have the fields read
// here, so old sessions still draw.

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Message } from "./broker/types.ts";

export interface InboundDetails {
	from: { id: string; name?: string; cwd?: string; transport?: "pi" | "claude" };
	message: Message;
	replyCommand?: string;
	bodyText?: string;
}

interface Theme {
	fg(slot: string, text: string): string;
}

export function senderLabel(from: InboundDetails["from"]): string {
	const name = from.name || from.id.slice(0, 8);
	return from.transport === "claude" ? `${name} · Claude Code` : name;
}

export function messageLines(details: InboundDetails, width: number, collapsed: boolean, theme: Theme): string[] {
	const sender = senderLabel(details.from);
	if (width < 3) return [truncateToWidth(`From ${sender}`, width)];
	const inner = Math.max(1, width - 2);
	const where = details.from.cwd ? ` (${details.from.cwd})` : "";
	const title = truncateToWidth(` From: ${sender}${where} `, inner, "");
	const lines = [theme.fg("muted", "╭") + theme.fg("toolTitle", title) + theme.fg("muted", `${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`)];
	const row = (content: string): string => {
		const text = truncateToWidth(content, inner, "");
		return theme.fg("muted", "│") + text + theme.fg("muted", `${" ".repeat(Math.max(0, inner - visibleWidth(text)))}│`);
	};
	const body = details.bodyText || details.message.content.text;
	const { replyTo, expectsReply, content } = details.message;
	const notes: string[] = [];
	if (details.replyCommand) notes.push(`To reply: ${details.replyCommand}`);
	if (content.attachments?.length) notes.push(`${content.attachments.length} attachment${content.attachments.length === 1 ? "" : "s"}`);
	if (replyTo && !expectsReply) notes.push(`Reply to ${replyTo.slice(0, 8)}`);
	if (collapsed) {
		lines.push(row(theme.fg("text", body.replace(/\s+/g, " ").trim())));
		lines.push(row(theme.fg("dim", ` ${[...notes, "ctrl+o to expand"].join(" · ")}`)));
	} else {
		for (const line of wrapTextWithAnsi(body, inner)) lines.push(row(theme.fg("text", line)));
		if (notes.length) {
			lines.push(row(""));
			for (const note of notes) for (const line of wrapTextWithAnsi(theme.fg("dim", ` ${note}`), inner)) lines.push(row(line));
		}
	}
	lines.push(theme.fg("muted", `╰${"─".repeat(inner)}╯`));
	return lines;
}
