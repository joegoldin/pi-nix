import { describe, expect, it } from "bun:test";
import type { UiTheme } from "./card.ts";
import { DEFAULTS } from "./config.ts";
import {
	buildCard,
	type CardDeps,
	type CardInput,
	displayPath,
	matcherFor,
	splitExit,
	splitNotice,
	summariseArgs,
	toolTitle,
} from "./tools.ts";

const plain: UiTheme = { fg: (_s, t) => t, bold: (t) => t, italic: (t) => t };
const deps: CardDeps = {
	theme: plain,
	config: { ...DEFAULTS, nerdIcons: false },
	highlight: (code) => code.split("\n"),
	languageOf: () => undefined,
};

const done = (toolName: string, args: Record<string, unknown>, text: string, over: Partial<CardInput> = {}): CardInput => ({
	toolName,
	args,
	result: { content: [{ type: "text", text }] },
	isPartial: false,
	isError: false,
	cwd: "/repo",
	...over,
});

describe("pi's output conventions", () => {
	it("splits the trailing notice off a result", () => {
		expect(splitNotice("a\nb\n\n[Showing lines 1-2 of 9. Use offset=3 to continue.]")).toEqual({
			body: "a\nb",
			notice: "[Showing lines 1-2 of 9. Use offset=3 to continue.]",
		});
		expect(splitNotice("[a] in the middle\nok").notice).toBeUndefined();
	});

	it("reads the exit code pi appends to a failing command", () => {
		expect(splitExit("boom\n\nCommand exited with code 2")).toEqual({ output: "boom", code: 2 });
		expect(splitExit("fine").code).toBeUndefined();
	});

	it("shows paths relative to the session when they are inside it", () => {
		expect(displayPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
		expect(displayPath("/etc/hosts", "/repo")).toBe("/etc/hosts");
		expect(displayPath("src/a.ts", "/repo")).toBe("src/a.ts");
	});
});

describe("read", () => {
	it("summarises the line count and numbers the body from the offset", () => {
		const card = buildCard(done("read", { path: "/repo/a.ts", offset: 10 }, "x\ny"), deps);
		expect(card.title).toBe("Read");
		expect(card.target).toBe("a.ts");
		expect(card.summary).toBe("Read 2 lines");
		expect(card.body).toEqual(["10  x", "11  y"]);
	});

	it("names pi's own documentation instead of its store path", () => {
		const path = "/nix/store/abc-pi/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md";
		const card = buildCard(done("read", { path }, "# Extensions"), deps);
		expect(card.title).toBe("Read docs");
		expect(card.target).toBe("pi docs/extensions.md");
	});

	it("says so for an image instead of dumping its note", () => {
		const input = done("read", { path: "a.png" }, "");
		input.result = { content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", mimeType: "image/png" }] };
		expect(buildCard(input, deps).summary).toContain("image/png");
	});

	it("stays a header while the call runs", () => {
		const card = buildCard({ ...done("read", { path: "a" }, ""), result: undefined }, deps);
		expect(card.state).toBe("pending");
		expect(card.summary).toBeUndefined();
	});
});

describe("bash", () => {
	it("keeps the end of the output, which is where the answer is", () => {
		const card = buildCard(done("bash", { command: "make" }, "a\nb\nc"), deps);
		expect(card.tail).toBe(true);
		expect(card.body).toEqual(["a", "b", "c"]);
	});

	it("marks a failing command as an error with its exit code", () => {
		const card = buildCard(done("bash", { command: "false" }, "nope\n\nCommand exited with code 1"), deps);
		expect(card.state).toBe("error");
		expect(card.summary).toBe("exit 1");
	});

	it("says when a command printed nothing", () => {
		expect(buildCard(done("bash", { command: "true" }, ""), deps).summary).toBe("(no output)");
	});

	it("flattens a multi-line command into the header", () => {
		expect(buildCard(done("bash", { command: "a &&\n  b" }, ""), deps).target).toBe("a && b");
	});
});

describe("edit", () => {
	it("counts the change and draws the diff at the card's width", () => {
		const input = done("edit", { path: "/repo/a.ts" }, "Successfully replaced");
		input.result = { ...input.result, details: { diff: "-1 old\n+1 new\n+2 more" } };
		const card = buildCard(input, deps);
		expect(card.title).toBe("Update");
		expect(card.summary).toBe("Updated a.ts with 2 additions and 1 removal");
		expect(typeof card.body).toBe("function");
		expect((card.body as (w: number) => string[])(60)).toHaveLength(3);
	});

	it("shows a failed edit's reason", () => {
		const card = buildCard(done("edit", { path: "a" }, "Could not find the text", { isError: true }), deps);
		expect(card.state).toBe("error");
		expect(card.summary).toBe("Could not find the text");
	});
});

describe("write", () => {
	it("counts what it wrote from the arguments, since the result does not say", () => {
		const card = buildCard(done("write", { path: "a.md", content: "one\ntwo\n" }, "Successfully wrote"), deps);
		expect(card.summary).toBe("Wrote 2 lines to a.md");
		expect(card.body).toEqual(["1  one", "2  two"]);
	});
});

describe("write over an existing file", () => {
	const diffDeps: CardDeps = { ...deps, diff: () => "-1 old\n+1 new" };

	it("shows the change as a diff", () => {
		const card = buildCard({ ...done("write", { path: "/repo/a.md", content: "new\n" }, "ok"), prior: "old\n" }, diffDeps);
		expect(card.summary).toBe("Overwrote a.md with 1 addition and 1 removal");
		expect(typeof card.body).toBe("function");
	});

	it("says so when the content did not change", () => {
		expect(buildCard({ ...done("write", { path: "a", content: "x" }, "ok"), prior: "x" }, diffDeps).summary).toBe("Unchanged");
	});

	it("previews the content for a new file or an unknown prior", () => {
		expect(buildCard({ ...done("write", { path: "a", content: "x" }, "ok"), prior: null }, diffDeps).summary).toBe("Wrote 1 line to a");
		expect(buildCard(done("write", { path: "a", content: "x" }, "ok"), diffDeps).summary).toBe("Wrote 1 line to a");
	});
});

describe("ls, find and grep", () => {
	it("lists directories and files", () => {
		const card = buildCard(done("ls", { path: "." }, "src/\nREADME.md"), deps);
		expect(card.summary).toBe("Listed 2 entries");
	});

	it("counts files found", () => {
		expect(buildCard(done("find", { pattern: "*.ts" }, "a.ts\nb.ts"), deps).summary).toBe("Found 2 files");
		expect(buildCard(done("find", { pattern: "*.x" }, "No files found matching pattern"), deps).summary).toBe("Found 0 files");
	});

	it("groups grep hits under their file, context lines dimmed apart from matches", () => {
		const out = "a.ts-1- before\na.ts:2: const hit = 1;\nb.ts:9: hit again";
		const card = buildCard(done("grep", { pattern: "hit" }, out), deps);
		expect(card.summary).toBe("Found 2 matches in 2 files");
		expect(card.body).toEqual(["a.ts", "    1  before", "    2: const hit = 1;", "b.ts", "    9: hit again"]);
	});

	it("says so plainly when grep finds nothing", () => {
		expect(buildCard(done("grep", { pattern: "x" }, "No matches found"), deps).summary).toBe("No matches");
	});

	it("builds a matcher for highlighting, and none for a pattern it cannot compile", () => {
		expect(matcherFor("a.b", true, false)?.test("a.b")).toBe(true);
		expect(matcherFor("a.b", true, false)?.test("axb")).toBe(false);
		expect(matcherFor("(", false, false)).toBeUndefined();
	});
});

describe("other tools", () => {
	it("names MCP tools by server and tool", () => {
		expect(toolTitle("mcp__github__search_issues")).toBe("github · search_issues");
		expect(toolTitle("todo")).toBe("todo");
	});

	it("lists arguments as key: value", () => {
		expect(summariseArgs({ q: "x", n: 2, skip: undefined })).toBe('q: "x", n: 2');
	});

	it("summarises with the first line of output", () => {
		const card = buildCard(done("mcp__x__y", { a: 1 }, "first\nsecond"), deps);
		expect(card.summary).toBe("first");
		expect(card.body).toEqual(["second"]);
	});
});

describe("intercom card", () => {
	it("names the action and target, and drops the markdown bold", () => {
		const card = buildCard(done("intercom", { action: "ask", to: "beta", message: "what is 2+2?" }, "**Reply from beta:**\n4"), deps);
		expect([card.title, card.target, card.detail, card.summary]).toEqual(["Intercom", "ask → beta", "what is 2+2?", "Reply from beta:"]);
		expect(card.body).toEqual(["4"]);
	});

	it("summarises a roster by its peer count", () => {
		const input = done("intercom", { action: "list" }, "**Current session:**\n• me", {
			result: { content: [{ type: "text", text: "**Current session:**\n• me" }], details: { roster: { peers: 2, total: 3 } } },
		});
		const card = buildCard(input, deps);
		expect(card.target).toBe("list");
		expect(card.summary).toBe("2 peers (3 connected)");
		expect(card.body).toEqual(["Current session:", "• me"]);
	});
});
