import { describe, expect, it } from "bun:test";
import { SECOND_KEY_LETTERS } from "./chord.ts";
import { createHintComponent, renderHint } from "./hint.ts";

const plainTheme = { fg: (_slot: string, text: string) => text };

describe("renderHint", () => {
	it("names every second key the reader accepts", () => {
		const body = renderHint("prefix", 60, plainTheme).join("\n");
		for (const key of SECOND_KEY_LETTERS) {
			expect(body).toContain(`${key}   `);
		}
	});

	it("says what the register step is waiting for", () => {
		const body = renderHint("append", 60, plainTheme).join("\n");
		expect(body).toContain("Append to register");
		expect(body).toContain("numbered slot");
	});

	it("always offers a way out", () => {
		for (const stage of ["prefix", "append"] as const) {
			expect(renderHint(stage, 60, plainTheme).join("\n")).toContain("esc");
		}
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
	it("follows the reader from the prefix step into the register step", () => {
		let stage: "prefix" | "append" = "prefix";
		const c = createHintComponent({ requestRender() {} }, plainTheme, () => stage);
		expect(c.render(60).join("\n")).toContain("stash");
		stage = "append";
		expect(c.render(60).join("\n")).toContain("Append to register");
	});

	it("swallows no keys: the reader has already taken the ones that matter", () => {
		let renders = 0;
		const c = createHintComponent({ requestRender: () => renders++ }, plainTheme, () => "prefix");
		c.handleInput("s");
		c.handleInput("\x1b");
		expect(renders).toBe(0);
	});

	it("repaints when invalidated", () => {
		let renders = 0;
		const c = createHintComponent({ requestRender: () => renders++ }, plainTheme, () => "prefix");
		c.invalidate();
		expect(renders).toBe(1);
	});
});
