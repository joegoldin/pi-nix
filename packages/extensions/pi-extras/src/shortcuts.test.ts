import { describe, expect, it } from "bun:test";
import { renderShortcuts } from "./shortcuts.ts";

const plain = { fg: (_slot: string, text: string) => text };

describe("renderShortcuts", () => {
	it("lists every key this extension binds", () => {
		const body = renderShortcuts(plain).join("\n");
		for (const keys of ["ctrl+s", "ctrl+g s", "ctrl+g u", "ctrl+g U", "ctrl+g l", "ctrl+g c", "ctrl+g x"]) {
			expect(body).toContain(keys);
		}
	});

	it("names the thing that has everything else, rather than a partial copy", () => {
		// pi's own keybindings and every other extension's are not something
		// extension code can enumerate, so this must not pretend to.
		const body = renderShortcuts(plain).join("\n");
		expect(body).toContain("/hotkeys");
	});

	it("fits inside pi's ten-line widget cap", () => {
		// InteractiveMode.MAX_WIDGET_LINES is 10, and pi truncates past it with
		// no warning to the extension -- silently dropped the close instruction
		// off the bottom of this exact panel once.
		expect(renderShortcuts(plain).length).toBeLessThanOrEqual(10);
	});

	it("says how to close it", () => {
		expect(renderShortcuts(plain).join("\n")).toContain("closes this");
	});

	it("colours through the theme rather than with literals", () => {
		const seen: string[] = [];
		renderShortcuts({
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
