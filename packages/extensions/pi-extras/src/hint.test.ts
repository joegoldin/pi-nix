import { describe, expect, it } from "bun:test";
import { SECOND_KEY_LETTERS } from "./chord.ts";
import { hintRows } from "./hint.ts";

describe("hintRows", () => {
	it("names every second key the reader accepts", () => {
		const row = hintRows("prefix")[0]!;
		for (const key of SECOND_KEY_LETTERS) {
			expect(row).toContain(`${key} `);
		}
	});


	it("always offers a way out", () => {
		for (const stage of ["prefix", "append"] as const) {
			expect(hintRows(stage)[0]!).toContain("esc");
		}
	});

	it("is a single row, so it never pushes the session down the terminal", () => {
		// The overlay this replaced padded twenty blank lines under the prompt
		// to reach a centre-anchored row. One row cannot.
		expect(hintRows("prefix")).toHaveLength(1);
		expect(hintRows("append")).toHaveLength(1);
	});
});
