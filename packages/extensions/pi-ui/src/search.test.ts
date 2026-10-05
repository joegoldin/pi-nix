import { describe, expect, it } from "bun:test";
import { fffGlob, fffQuery, formatGrep, insideRoot, withinSearch } from "./search.ts";

const keep = (line: string) => ({ text: line, wasTruncated: false });

describe("insideRoot", () => {
	it("names paths inside the index the way the index does", () => {
		expect(insideRoot("/repo", "/repo")).toBe("");
		expect(insideRoot("/repo", "/repo/src/a")).toBe("src/a");
		expect(insideRoot("/repo", "src")).toBe("src");
	});

	it("refuses paths outside it, which fd and ripgrep answer instead", () => {
		expect(insideRoot("/repo", "/etc")).toBeUndefined();
		expect(insideRoot("/repo", "../other")).toBeUndefined();
	});
});

describe("fffGlob", () => {
	it("makes a bare pattern recursive, as fd treats it", () => {
		expect(fffGlob("*.ts", "")).toBe("**/*.ts");
	});

	it("roots the pattern at the searched directory", () => {
		expect(fffGlob("*.ts", "src")).toBe("src/**/*.ts");
		expect(fffGlob("lib/*.ts", "src")).toBe("src/lib/*.ts");
		expect(fffGlob("**/x", "")).toBe("**/x");
	});
});

describe("fffQuery", () => {
	it("searches plain text when the pattern is literal and case matters", () => {
		expect(fffQuery("a.b", true, false)).toEqual({ query: "a.b", mode: "plain" });
	});

	it("escapes a literal into a regex when case does not matter", () => {
		expect(fffQuery("a.b", true, true)).toEqual({ query: "(?i)a\\.b", mode: "regex" });
	});

	it("passes a regex through", () => {
		expect(fffQuery("fo+", false, false)).toEqual({ query: "fo+", mode: "regex" });
	});
});

describe("formatGrep", () => {
	const m = { relativePath: "src/a.ts", lineNumber: 5, lineContent: "hit", contextBefore: ["b4"], contextAfter: ["after"] };

	it("matches pi's grep output line for line", () => {
		expect(formatGrep([m], "", false, keep).lines).toEqual(["src/a.ts-4- b4", "src/a.ts:5: hit", "src/a.ts-6- after"]);
	});

	it("makes paths relative to the searched directory", () => {
		expect(formatGrep([{ ...m, contextBefore: [], contextAfter: [] }], "src", false, keep).lines).toEqual(["a.ts:5: hit"]);
	});

	it("uses the bare file name when one file was searched", () => {
		expect(formatGrep([{ ...m, contextBefore: [], contextAfter: [] }], "src/a.ts", true, keep).lines).toEqual(["a.ts:5: hit"]);
	});

	it("reports when it shortened a line", () => {
		const out = formatGrep([m], "", false, (line) => ({ text: line, wasTruncated: line === "hit" }));
		expect(out.linesTruncated).toBe(true);
	});
});

describe("withinSearch", () => {
	it("keeps matches under the searched directory and skips binaries", () => {
		expect(withinSearch({ relativePath: "src/a", lineNumber: 1, lineContent: "" }, "src", false)).toBe(true);
		expect(withinSearch({ relativePath: "srcx/a", lineNumber: 1, lineContent: "" }, "src", false)).toBe(false);
		expect(withinSearch({ relativePath: "a", lineNumber: 1, lineContent: "", isBinary: true }, "", false)).toBe(false);
	});
});
