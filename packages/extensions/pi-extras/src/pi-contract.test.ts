// Differential test against pi's own source. This extension binds keys the
// editor would otherwise receive, and subscribes to events and UI methods that
// fail silently when they are renamed: a handler registered for an event pi
// never fires is invisible, and an optional UI method that disappears takes its
// feature with it.
//
// PI_CODING_AGENT_SRC points at the unpacked pi source; the Nix check sets it.
// The file skips without it, so `bun test` still works in a plain checkout.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = process.env.PI_CODING_AGENT_SRC;
const read = (path: string) => readFileSync(`${SRC}/packages/coding-agent/src/${path}`, "utf8");
const types = () => read("core/extensions/types.ts");

const describeAgainstPi = SRC === undefined ? describe.skip : describe;

describeAgainstPi("the events pi-extras subscribes to", () => {
	it("are all declared on ExtensionAPI.on", () => {
		const source = types();
		for (const event of ["session_start", "agent_start", "agent_settled", "session_shutdown", "input"]) {
			expect(source).toContain(`on(event: "${event}", handler:`);
		}
	});

	it("let an input handler rewrite the text, which is how @~ is expanded", () => {
		expect(types()).toContain('action: "transform"');
	});
});

describeAgainstPi("the surfaces pi-extras calls", () => {
	it("declares every optional UI method the chords reach", () => {
		const source = types();
		for (const method of [
			"onTerminalInput(handler: TerminalInputHandler)",
			"setTitle(title: string)",
			"getEditorText(): string",
			"setEditorText(text: string)",
			"pasteToEditor(text: string)",
		]) {
			expect(source).toContain(method);
		}
	});

	// The chord is built on the listener consuming the key before the editor
	// sees it. Without `consume` the prefix would land in the prompt.
	it("lets a terminal input handler consume the key", () => {
		const source = types();
		const start = source.indexOf("export type TerminalInputHandler");
		expect(start).toBeGreaterThan(-1);
		expect(source.slice(start, start + 200)).toContain("consume?: boolean");
	});

	it("runs extension input listeners before the focused component", () => {
		const tui = readFileSync(`${SRC}/packages/tui/src/tui.ts`, "utf8");
		const dispatch = tui.indexOf("handleTerminalInput");
		expect(dispatch).toBeGreaterThan(-1);
		const body = tui.slice(dispatch);
		expect(body.indexOf("inputListeners")).toBeLessThan(body.indexOf("focusedComponent?.handleInput"));
	});

	it("keeps newSession and fork on the command context, not the plain one", () => {
		const source = types();
		const start = source.indexOf("export interface ExtensionCommandContext");
		expect(start).toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf("\n}", start));
		expect(body).toContain("newSession(");
		expect(body).toContain("fork(");
	});

	it("keeps shutdown on the plain context, because /exit is reachable everywhere", () => {
		expect(types()).toContain("shutdown(): void;");
	});

	it("exposes the thinking level as a getter and a setter on the API", () => {
		const source = types();
		expect(source).toContain("getThinkingLevel(): ThinkingLevel;");
		expect(source).toContain("setThinkingLevel(level: ThinkingLevel): void;");
	});

	it("still has every level the ctrl+s t cycle walks", () => {
		const source = readFileSync(`${SRC}/packages/agent/src/types.ts`, "utf8");
		const start = source.indexOf("export type ThinkingLevel");
		expect(start).toBeGreaterThan(-1);
		const declaration = source.slice(start, source.indexOf(";", start));
		for (const level of ["off", "low", "medium", "high", "xhigh"]) {
			expect(declaration).toContain(`"${level}"`);
		}
	});
});

describeAgainstPi("the prefix key", () => {
	// ctrl+s is free in the editor. pi binds it only inside the session picker
	// and the model selector, neither of which is on screen while the prompt
	// has focus. A pi that binds it in the editor would take the chord away
	// silently, so this is the test that notices.
	it("is bound by pi only in overlay scopes", () => {
		const source = read("core/keybindings.ts");
		const owners = [...source.matchAll(/"(app\.[\w.]+)":\s*\{\s*\n\s*defaultKeys: "ctrl\+s"/g)].map((m) => m[1]);
		expect(owners.sort()).toEqual(["app.models.save", "app.session.toggleSort"]);
	});

	it("is not a default in the tui layer either", () => {
		expect(readFileSync(`${SRC}/packages/tui/src/keybindings.ts`, "utf8")).not.toContain('"ctrl+s"');
	});
});
