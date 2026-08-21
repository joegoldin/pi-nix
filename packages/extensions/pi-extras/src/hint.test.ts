import { describe, expect, it } from "bun:test";
import { SECOND_KEY_LETTERS } from "./chord.ts";
import { renderHint } from "./hint.ts";

const plain = { fg: (_slot: string, text: string) => text };

describe("renderHint", () => {
	it("names every second key the reader accepts", () => {
		const body = renderHint("prefix", plain).join("\n");
		for (const key of SECOND_KEY_LETTERS) {
			expect(body).toContain(`${key}   `);
		}
	});

	it("names no key the reader does not accept", () => {
		// The registers and the append step were listed here after they were
		// removed, which is a menu lying about what the keys do.
		const body = renderHint("prefix", plain).join("\n");
		expect(body).not.toContain("append");
		expect(body).not.toContain("0-9");
	});

	it("offers a way out", () => {
		expect(renderHint("prefix", plain).join("\n")).toContain("esc");
	});

	it("colours through the theme rather than with literals", () => {
		const seen: string[] = [];
		renderHint("prefix", {
			fg: (slot, text) => {
				seen.push(slot);
				return text;
			},
		});
		expect(seen).toContain("toolTitle");
		expect(seen).toContain("accent");
		expect(seen).toContain("muted");
	});
});

describe("the menu as a widget", () => {
	it("is a list, not one crammed line", () => {
		// It was a single row once and read as a wall of keys. setWidget takes a
		// string[], so there is no reason for it to be.
		const rows = renderHint("prefix", plain);
		expect(rows.length).toBeGreaterThan(5);
		expect(rows[0]).toBe("Prompt stash");
	});

	it("puts one key on each row", () => {
		const rows = renderHint("prefix", plain);
		for (const row of rows.slice(1, -1)) {
			expect(row.trim().split(/\s{2,}/)).toHaveLength(2);
		}
	});
});
