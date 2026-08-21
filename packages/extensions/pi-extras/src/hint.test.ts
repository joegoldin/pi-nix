import { describe, expect, it } from "bun:test";
import { SECOND_KEY_LETTERS } from "./chord.ts";
import { createHintComponent, renderHint } from "./hint.ts";

const plain = { fg: (_slot: string, text: string) => text };

describe("renderHint", () => {
	it("names every second key the reader accepts", () => {
		const body = renderHint("prefix", 60, plain).join("\n");
		for (const key of SECOND_KEY_LETTERS) {
			expect(body).toContain(`${key}   `);
		}
	});

	it("names no key the reader does not accept", () => {
		// The registers and the append step were listed here after they were
		// removed, which is a menu lying about what the keys do.
		const body = renderHint("prefix", 60, plain).join("\n");
		expect(body).not.toContain("append");
		expect(body).not.toContain("0-9");
	});

	it("offers a way out", () => {
		expect(renderHint("prefix", 60, plain).join("\n")).toContain("esc");
	});

	it("colours through the theme rather than with literals", () => {
		const seen: string[] = [];
		renderHint("prefix", 60, {
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

describe("createHintComponent", () => {
	it("swallows no keys: the reader has already taken the ones that matter", () => {
		let renders = 0;
		const c = createHintComponent({ requestRender: () => renders++ }, plain, () => "prefix");
		c.handleInput("s");
		c.handleInput("\x1b");
		expect(renders).toBe(0);
	});

	it("repaints when invalidated", () => {
		let renders = 0;
		const c = createHintComponent({ requestRender: () => renders++ }, plain, () => "prefix");
		c.invalidate();
		expect(renders).toBe(1);
	});
});
