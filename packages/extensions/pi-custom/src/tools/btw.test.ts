import { describe, expect, it } from "bun:test";
import { bringBackDraft, conversationContext, firstMessage, followUpMessage } from "./btw.ts";

describe("the side model's context", () => {
	it("keeps what was said and what tools were called, not tool output", () => {
		const text = conversationContext([
			{ type: "message", message: { role: "user", content: "fix it" } },
			{
				type: "message",
				message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Looking." }, { type: "toolCall", name: "read", arguments: { path: "a" } }] },
			},
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "secret file body" }] } },
		]);
		expect(text).toBe('User: fix it\n\nAssistant (toolUse): Looking.\nTool call: read({"path":"a"})');
		expect(text).not.toContain("secret file body");
	});

	it("keeps the tail of a long conversation and says it did", () => {
		const text = conversationContext([{ type: "message", message: { role: "user", content: "x".repeat(50_000) } }]);
		expect(text).toStartWith("[Earlier context omitted; showing the last 40000 characters.]");
		expect(text.length).toBeLessThan(40_100);
	});
});

describe("messages", () => {
	it("frames the first question with the context and follow-ups without it", () => {
		expect(firstMessage("why?", "")).toContain("No prior conversation context was available.");
		expect(firstMessage("why?", "ctx")).toContain("<side_question>\nwhy?\n</side_question>");
		expect(followUpMessage("and?")).not.toContain("conversation_context");
	});

	it("brings an answer back as discussion, not as done work", () => {
		const draft = bringBackDraft({ question: "q", answer: "a" });
		expect(draft).toContain("Treat it as discussion context, not as work already completed.");
		expect(draft).toContain("<btw_context>\nUser:\nq\n\nAssistant:\na\n</btw_context>");
	});
});
