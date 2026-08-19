import { describe, expect, it } from "bun:test";
import { THINKING_CYCLE, expandPathRefs, findPathRefs, nextThinkingLevel, unresolvedRefs } from "./input.ts";

describe("nextThinkingLevel", () => {
	it("advances through the cycle", () => {
		expect(nextThinkingLevel("off")).toBe("low");
		expect(nextThinkingLevel("low")).toBe("medium");
		expect(nextThinkingLevel("medium")).toBe("high");
		expect(nextThinkingLevel("high")).toBe("xhigh");
	});

	it("wraps from the top back to off", () => {
		expect(nextThinkingLevel("xhigh")).toBe("off");
	});

	it("returns to the start of the cycle after a full lap", () => {
		let level = "off";
		for (const _ of THINKING_CYCLE) level = nextThinkingLevel(level);
		expect(level).toBe("off");
	});

	// pi's ThinkingLevel also has "minimal" and "max", which this cycle skips.
	// Landing on one of them means something else set it, so restart rather
	// than guess where in the cycle it belongs.
	it("restarts the cycle from a level outside it", () => {
		expect(nextThinkingLevel("minimal")).toBe("off");
		expect(nextThinkingLevel("max")).toBe("off");
		expect(nextThinkingLevel(undefined)).toBe("off");
	});
});

describe("findPathRefs", () => {
	it("finds a reference at the start of the input", () => {
		expect(findPathRefs("@src/index.ts please read it")).toEqual([
			{ token: "@src/index.ts", path: "src/index.ts", start: 0, end: 13 },
		]);
	});

	it("finds a reference after whitespace", () => {
		expect(findPathRefs("read @a/b.ts").map((r) => r.path)).toEqual(["a/b.ts"]);
	});

	it("finds several", () => {
		expect(findPathRefs("@a.ts and @b.ts").map((r) => r.path)).toEqual(["a.ts", "b.ts"]);
	});

	// An email address and a decorator are the two things an @-in-the-middle
	// rule has to keep out.
	it("ignores an at sign glued to the preceding word", () => {
		expect(findPathRefs("mail joe@example.com")).toEqual([]);
	});

	it("ignores a bare at sign", () => {
		expect(findPathRefs("@ and @")).toEqual([]);
	});

	it("drops trailing sentence punctuation from the path", () => {
		expect(findPathRefs("look at @src/a.ts, then @src/b.ts.").map((r) => r.path)).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

describe("expandPathRefs", () => {
	// pi resolves a relative @path against the cwd but does nothing with a
	// tilde, so the agent would be handed a directory literally named "~".
	it("expands a tilde reference to the home directory", () => {
		expect(expandPathRefs("read @~/notes/todo.md", "/home/joe")).toBe("read @/home/joe/notes/todo.md");
	});

	it("leaves a relative reference alone, because pi resolves those already", () => {
		expect(expandPathRefs("read @src/a.ts", "/home/joe")).toBe("read @src/a.ts");
	});

	it("leaves an absolute reference alone", () => {
		expect(expandPathRefs("read @/etc/hosts", "/home/joe")).toBe("read @/etc/hosts");
	});

	it("expands every reference in one pass", () => {
		expect(expandPathRefs("@~/a @~/b", "/home/joe")).toBe("@/home/joe/a @/home/joe/b");
	});

	it("returns the input unchanged when there is nothing to expand", () => {
		expect(expandPathRefs("plain text", "/home/joe")).toBe("plain text");
	});

	it("does not touch a bare tilde that is not a reference", () => {
		expect(expandPathRefs("about ~/notes", "/home/joe")).toBe("about ~/notes");
	});
});

describe("unresolvedRefs", () => {
	const exists = (path: string) => path === "/repo/src/a.ts" || path === "/home/joe/notes.md";

	it("says nothing when every reference resolves", () => {
		expect(unresolvedRefs("@src/a.ts", "/repo", "/home/joe", exists)).toEqual([]);
	});

	it("resolves a relative reference against the cwd", () => {
		expect(unresolvedRefs("@src/gone.ts", "/repo", "/home/joe", exists)).toEqual(["@src/gone.ts"]);
	});

	it("resolves a tilde reference against the home directory", () => {
		expect(unresolvedRefs("@~/notes.md", "/repo", "/home/joe", exists)).toEqual([]);
	});

	it("resolves an absolute reference as given", () => {
		expect(unresolvedRefs("@/repo/src/a.ts", "/repo", "/home/joe", exists)).toEqual([]);
	});

	it("reports each unresolved reference once", () => {
		expect(unresolvedRefs("@x.ts and @x.ts", "/repo", "/home/joe", exists)).toEqual(["@x.ts"]);
	});

	// A stat that throws is a permission problem on the path, not proof that
	// the user mistyped it.
	it("treats a probe that throws as resolved", () => {
		expect(
			unresolvedRefs("@src/a.ts", "/repo", "/home/joe", () => {
				throw new Error("EACCES");
			}),
		).toEqual([]);
	});
});
