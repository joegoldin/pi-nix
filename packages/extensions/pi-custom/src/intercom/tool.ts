// The `intercom` tool. One tool for both kinds of peer: the name and the
// `action: "ask"` value are what pi-subagents keys on (a blocking ask, an
// agent that requires intercom), and the parameters are pi-intercom's minus
// Herdr's project-pane options, so the model's habits and recorded sessions
// carry over.

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Intercom } from "./runtime.ts";

const DESCRIPTION = `Send a message to another agent session running on this machine: another pi session, or a Claude Code session.
Use this to communicate findings, request help, or coordinate work with other sessions.

Target a session by name, full session ID, or the short id shown in parentheses
by "list" (a leading prefix of the ID is enough). Prefer the short id when two
sessions share a name. Claude Code sessions are listed separately; "claude:<name>"
or "pi:<name>" picks one when a name is in both lists. Re-list before reusing a
session ID; skip if it resolves to self.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "list-cwd" })                → List sessions in the current working directory
  intercom({ action: "list-cwd", cwd: "/path" })  → List sessions in a specific directory
  intercom({ action: "send", to: "name-or-id", message: "..." })  → Send message
  intercom({ action: "ask", to: "name-or-id", message: "..." })   → Ask and wait for reply
  intercom({ action: "handover", to: "name-or-id", message: "next task" }) → Summarize this session and hand it over; the receiver acts on it
  intercom({ action: "cancel", messageId: "..." })                 → Request cancellation of a sent message (pi sessions only)
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status`;

/** `intercom()` is null between sessions, before the first session_start. */
export function registerIntercomTool(pi: ExtensionAPI, intercom: () => Intercom | null): void {
	pi.registerTool({
		name: "intercom",
		label: "Intercom",
		description: DESCRIPTION,
		// One fixed string: a snippet that changed with state would break prompt caching (pi-intercom #118).
		promptSnippet: "Use to coordinate with other local agent sessions (pi or Claude Code): list peers, send updates, ask for help, or check intercom connectivity.",
		parameters: Type.Object({
			action: StringEnum(["list", "list-cwd", "send", "ask", "handover", "reply", "pending", "status", "cancel"] as const, {
				description:
					"Action: 'list', 'list-cwd', 'send', 'ask', 'handover', 'reply', 'pending', 'status', or 'cancel'. 'handover' summarizes this session with the current model and sends it to the target, which acts on it; 'message' is the optional next task.",
			}),
			to: Type.Optional(
				Type.String({
					description:
						"Target session: name, full session ID, or the short id shown in parentheses by 'list' (a leading ID prefix resolves); 'claude:<name>' or 'pi:<name>' when a name is in both lists. For send/ask/handover with cwd, omit to target the sole live session in that cwd. For 'reply', disambiguates the pending ask.",
				}),
			),
			message: Type.Optional(
				Type.String({ description: "Message to send (for 'send', 'ask', or 'reply' action). For 'handover', the optional next task for the receiver." }),
			),
			attachments: Type.Optional(
				Type.Array(
					Type.Object({
						type: StringEnum(["file", "snippet", "context"] as const),
						name: Type.String(),
						content: Type.String(),
						language: Type.Optional(Type.String()),
					}),
				),
			),
			replyTo: Type.Optional(Type.String({ description: "Message ID to reply to (for threading or responding to an 'ask')" })),
			messageId: Type.Optional(Type.String({ description: "Message ID for actions that operate on an existing message, such as 'cancel'." })),
			supersedes: Type.Optional(
				Type.String({ description: "Previous message ID this send/ask explicitly supersedes. Only works for the same sender and receiver." }),
			),
			retryOf: Type.Optional(
				Type.String({ description: "Previous message ID this send/ask is a user-authored retry of. Retries always send a new message ID." }),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory filter for 'list-cwd'. For send/ask/handover, scopes target lookup to that directory; omit 'to' to target the sole live peer there. Absolute, or relative to the current session's cwd; '.' means the current cwd.",
				}),
			),
		}),

		async execute(_id, params, signal, _onUpdate, ctx) {
			const runtime = intercom();
			if (!runtime) return { content: [{ type: "text", text: "Intercom not connected: no session yet" }], details: { error: true } };
			const { action, to, message, attachments, replyTo, messageId, supersedes, retryOf, cwd } = params;
			const missing = (what: string) => ({ content: [{ type: "text" as const, text: what }], details: { error: true } });
			switch (action) {
				case "list":
					return runtime.list();
				case "list-cwd":
					return runtime.list(cwd ?? ".");
				case "send":
					if ((!to && !cwd) || !message) return missing("Missing 'to' or 'cwd', or missing 'message' parameter");
					return runtime.send(ctx, { to, cwd, message, attachments, replyTo, supersedes, retryOf }, signal);
				case "ask":
					if ((!to && !cwd) || !message) return missing("Missing 'to' or 'cwd', or missing 'message' parameter");
					return runtime.ask(ctx, { to, cwd, message, attachments, replyTo, supersedes, retryOf }, signal);
				case "handover":
					if (!to && !cwd) return missing("Missing 'to' or 'cwd' parameter");
					if (replyTo || supersedes || retryOf || attachments?.length) {
						return missing("Handover always sends a new message; replyTo, supersedes, retryOf, and attachments are not supported.");
					}
					return runtime.handover(ctx, { to, cwd, goal: message }, signal);
				case "reply":
					if (!message) return missing("Missing 'message' parameter");
					return runtime.reply({ to, replyTo, message, attachments });
				case "pending":
					return runtime.pending();
				case "status":
					return runtime.status();
				case "cancel":
					if (!messageId) return missing("Missing 'messageId' parameter");
					return runtime.cancel(messageId);
			}
		},
	});
}
