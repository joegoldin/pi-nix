import { describe, expect, it } from "bun:test";
import { hintRows } from "./hint.ts";
import { SECOND_KEY_LETTERS } from "./chord.ts";

describe("hintRows", () => {
	it("names every second key the reader accepts", () => {
		const row = hintRows("prefix")[0]!;
		for (const key of SECOND_KEY_LETTERS) {
			expect(row).toContain(`${key} `);
		}
	});

	it("tells the append step what it is waiting for", () => {
		expect(hintRows("append")[0]!).toContain("register");
	});

	it("is one row, so it never pushes the prompt around", () => {
		expect(hintRows("prefix")).toHaveLength(1);
		expect(hintRows("append")).toHaveLength(1);
	});
});
