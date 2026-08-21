import { describe, expect, it } from "bun:test";
import { filterEntries, windowFor } from "./filter.ts";

const entries = ["rework the permission envelope", "drop the bare-directory rules", "bump the cache row"];

describe("filterEntries", () => {
	it("returns everything for an empty query, in stash order", () => {
		expect(filterEntries(entries, "").map((e) => e.index)).toEqual([0, 1, 2]);
	});

	it("keeps the original index, because that is the register", () => {
		// Filtering must not renumber: `ctrl+s a 2` still means entry 2.
		expect(filterEntries(entries, "bump")).toEqual([{ index: 2, text: "bump the cache row" }]);
	});

	it("matches case-insensitively", () => {
		expect(filterEntries(entries, "PERMISSION")).toHaveLength(1);
	});

	it("matches across a line break, because the text is flattened first", () => {
		expect(filterEntries(["fix the\npermission envelope"], "the permission")).toHaveLength(1);
	});

	it("ignores surrounding whitespace in the query", () => {
		expect(filterEntries(entries, "  cache  ")).toHaveLength(1);
	});

	it("returns nothing when nothing matches", () => {
		expect(filterEntries(entries, "zzz")).toEqual([]);
	});
});

describe("windowFor", () => {
	it("shows everything when the list fits", () => {
		expect(windowFor(3, 2, 10)).toBe(0);
	});

	it("scrolls just far enough to bring the cursor into view", () => {
		expect(windowFor(20, 10, 5, 0)).toBe(6);
	});

	it("follows the cursor back up by one", () => {
		expect(windowFor(20, 5, 5, 6)).toBe(5);
	});

	it("holds still while the cursor stays inside the window", () => {
		expect(windowFor(20, 8, 5, 6)).toBe(6);
	});

	it("never scrolls past the end", () => {
		expect(windowFor(20, 19, 5, 99)).toBe(15);
	});

	it("survives no room at all", () => {
		expect(windowFor(20, 5, 0)).toBe(0);
	});
});
