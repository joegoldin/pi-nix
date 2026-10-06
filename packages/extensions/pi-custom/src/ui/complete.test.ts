import { describe, expect, it } from "bun:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { type CompleterSources, createCompleter } from "./complete.ts";

const signal = new AbortController().signal;

function fakeCurrent(): AutocompleteProvider & { applied: number } {
	return {
		applied: 0,
		async getSuggestions(lines, line, col) {
			const before = lines[line].slice(0, col);
			const m = /@(\S*)$/.exec(before);
			return m ? { items: [{ value: "@README.md", label: "README.md" }], prefix: `@${m[1]}` } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			this.applied++;
			return { lines, cursorLine, cursorCol };
		},
	};
}

const sources = (over: Partial<CompleterSources> = {}): CompleterSources => ({
	sessionsEnabled: () => true,
	agentsEnabled: () => true,
	files: () => undefined,
	sessions: async () => [
		{ id: "s1", path: "/s1", firstMessage: "fix the parser", modified: new Date(), messageCount: 2 },
	],
	agents: () => [{ name: "oracle", description: "wise" }],
	currentSessionId: () => undefined,
	trackFile: () => {},
	...over,
});

describe("the @ completer", () => {
	it("answers @session: from the session list", async () => {
		const p = createCompleter(sources())(fakeCurrent());
		const got = await p.getSuggestions(["@session:fix"], 0, 12, { signal });
		expect(got?.prefix).toBe("@session:fix");
		expect(got?.items[0].value).toBe("@session:s1");
	});

	it("answers @agent: from the agent list", async () => {
		const p = createCompleter(sources())(fakeCurrent());
		const got = await p.getSuggestions(["@agent:or"], 0, 9, { signal });
		expect(got?.items.map((i) => i.value)).toEqual(["@agent:oracle"]);
	});

	it("offers the keywords beside pi's own file completions", async () => {
		const p = createCompleter(sources())(fakeCurrent());
		const got = await p.getSuggestions(["@"], 0, 1, { signal });
		expect(got?.items.map((i) => i.value)).toEqual(["@session:", "@agent:", "@README.md"]);
	});

	it("drops a keyword whose feature is off", async () => {
		const p = createCompleter(sources({ agentsEnabled: () => false }))(fakeCurrent());
		const got = await p.getSuggestions(["@"], 0, 1, { signal });
		expect(got?.items.map((i) => i.value)).not.toContain("@agent:");
	});

	it("ranks files through FFF when it has an index", async () => {
		const p = createCompleter(sources({ files: () => [{ value: "@src/hot.ts", label: "hot.ts" }] }))(fakeCurrent());
		const got = await p.getSuggestions(["@ho"], 0, 3, { signal });
		expect(got?.items.map((i) => i.value)).toEqual(["@src/hot.ts"]);
	});

	it("leaves the cursor after the colon for a keyword, and spaces after a reference", () => {
		const p = createCompleter(sources())(fakeCurrent());
		const kw = p.applyCompletion(["see @se"], 0, 7, { value: "@session:", label: "@session:" }, "@se");
		expect(kw.lines[0]).toBe("see @session:");
		expect(kw.cursorCol).toBe(13);
		const ref = p.applyCompletion(["@agent:or x"], 0, 9, { value: "@agent:oracle", label: "oracle" }, "@agent:or");
		expect(ref.lines[0]).toBe("@agent:oracle  x");
	});

	it("hands file completions back to pi and records the choice for ranking", () => {
		const current = fakeCurrent();
		const tracked: string[] = [];
		const p = createCompleter(sources({ trackFile: (q, v) => tracked.push(`${q}->${v}`) }))(current);
		p.applyCompletion(["@ho"], 0, 3, { value: "@src/hot.ts", label: "hot.ts" }, "@ho");
		expect(current.applied).toBe(1);
		expect(tracked).toEqual(["ho->@src/hot.ts"]);
	});

	it("passes anything else through untouched", async () => {
		const p = createCompleter(sources())(fakeCurrent());
		expect(await p.getSuggestions(["/mod"], 0, 4, { signal })).toBeNull();
	});
});
