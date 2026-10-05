import { describe, expect, it } from "bun:test";
import { DEFAULTS } from "./config.ts";
import { linkUrls, renderCallouts, transformMarkdown, trimUrl } from "./markdown.ts";

const user = { messageType: "user" as const, isStreaming: false };
const assistant = { messageType: "assistant" as const, isStreaming: false };

describe("callouts", () => {
	it("turns a GitHub callout marker into a bold label inside the quote", () => {
		expect(renderCallouts("> [!NOTE]\n> body")).toBe("> **ⓘ Note**\n> body");
		expect(renderCallouts("> [!warning] careful")).toBe("> **⚠ Warning** careful");
	});

	it("leaves examples in code fences alone", () => {
		const md = "```md\n> [!NOTE]\n```";
		expect(renderCallouts(md)).toBe(md);
	});
});

describe("bare URLs", () => {
	it("become links", () => {
		expect(linkUrls("see https://pi.dev now")).toBe("see [https://pi.dev](https://pi.dev) now");
	});

	it("drop trailing punctuation from the link but keep it in the text", () => {
		expect(linkUrls("at https://pi.dev.")).toBe("at [https://pi.dev](https://pi.dev).");
	});

	it("keep balanced parentheses and lose an unbalanced closing one", () => {
		expect(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
		expect(linkUrls("(see https://pi.dev)")).toBe("(see [https://pi.dev](https://pi.dev))");
	});

	it("leave existing links, autolinks and code alone", () => {
		for (const md of ["[x](https://pi.dev)", "<https://pi.dev>", "`https://pi.dev`", "```\nhttps://pi.dev\n```", "[https://pi.dev](https://pi.dev)"]) {
			expect(linkUrls(md)).toBe(md);
		}
	});
});

describe("transformMarkdown", () => {
	it("puts the prompt icon before your messages only", () => {
		expect(transformMarkdown("hi", user, DEFAULTS)).toBe("❯ hi");
		expect(transformMarkdown("hi", assistant, DEFAULTS)).toBe("hi");
	});

	it("leaves thinking untouched", () => {
		const md = "> [!NOTE] https://x.dev";
		expect(transformMarkdown(md, { messageType: "assistant-thinking", isStreaming: true }, DEFAULTS)).toBe(md);
	});

	it("follows the settings", () => {
		const off = { ...DEFAULTS, promptIcon: false, admonitions: false, linkUrls: false };
		expect(transformMarkdown("> [!NOTE] https://x.dev", user, off)).toBe("> [!NOTE] https://x.dev");
	});
});
