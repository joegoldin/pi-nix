import { expect, test } from "bun:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { createPromptEditor } from "./editor.ts";

const identity = (text: string) => text;
function editor() {
	const Prompt = createPromptEditor(CustomEditor as never, () => identity);
	return new Prompt({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, { borderColor: identity, selectList: {} }, { matches: () => false }) as unknown as CustomEditor;
}
function paste(target: CustomEditor, text: string) { target.handleInput(`\x1b[200~${text}\x1b[201~`); }
const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");

test("repeating a collapsed paste expands it once, including further repeats", () => {
	const target = editor();
	paste(target, long);
	expect(target.getText()).toContain("[paste #1");
	paste(target, long);
	expect(target.getText()).toBe(long);
	paste(target, long);
	paste(target, long);
	expect(target.getText()).toBe(long);
	expect(target.getExpandedText()).toBe(long);
});

test("expansion preserves surrounding text, other collapsed pastes and native undo", () => {
	const target = editor();
	paste(target, "z".repeat(1100));
	target.insertTextAtCursor("\nhello ");
	paste(target, long);
	const collapsed = target.getText();
	const expanded = target.getExpandedText();
	paste(target, long);
	expect(target.getText()).toBe(`[paste #1 1100 chars]\nhello ${long}`);
	expect(target.getExpandedText()).toBe(expanded);
	target.handleInput("\x1f");
	expect(target.getText()).toBe(collapsed);
	expect(target.getExpandedText()).toBe(expanded);
	paste(target, long);
	expect(target.getExpandedText()).toBe(expanded);
});

test("different pastes, short pastes, and edits keep native insertion behavior", () => {
	const target = editor();
	paste(target, "hi"); paste(target, "hi");
	expect(target.getText()).toBe("hihi");
	paste(target, long); target.handleInput("!"); paste(target, long);
	expect(target.getExpandedText()).toBe(`hihi${long}!${long}`);
	paste(target, `${long} different`);
	expect(target.getExpandedText()).toEndWith(`${long} different`);
});

test("native bracketed-paste buffering and normalization still apply", () => {
	const target = editor();
	const raw = `${long.replaceAll("\n", "\r\n")}\r\n\tend`;
	paste(target, raw);
	target.handleInput("\x1b[200~");
	target.handleInput(raw.slice(0, 20));
	target.handleInput(raw.slice(20));
	target.handleInput("\x1b[201~");
	expect(target.getText()).toBe(`${long}\n    end`);
});

test("fullscreen copying omits the prompt frame and gutter, not typed decoration or indentation", async () => {
	const { TuiAltScreen } = await import("@earendil-works/pi-tui");
	const copied: string[] = [];
	const terminal = { columns: 80, rows: 40, write() {}, hideCursor() {}, showCursor() {}, moveBy() {}, setCursorPosition() {}, clearLine() {}, clearFromCursor() {} };
	const tui = new TuiAltScreen(terminal as never, false, undefined, { copySelection: async (text) => { copied.push(text); return true; } });
	tui.requestRender = () => {};
	const Prompt = createPromptEditor(CustomEditor as never, () => identity);
	const target = new Prompt(tui, { borderColor: identity, selectList: {} }, { matches: () => false }) as unknown as CustomEditor;
	target.setText("hello │ world\n  indented ❯ text");
	tui.addChild(target);
	const internals = tui as any;
	tui.setLayoutRoot(target);
	internals.stopped = false;
	internals.altScreenActive = true;
	internals.doRender();
	internals.selectionAnchor = { row: 0, col: 0 };
	internals.selectionFocus = { row: 3, col: 79 };
	const native = (TuiAltScreen.prototype as any).getActiveSelectionText.call(tui);
	expect(native).toContain("╭");
	expect(native).toContain("╰");
	await tui.copyActiveSelectionToClipboard();
	expect(copied).toEqual(["hello │ world\n  indented ❯ text"]);
	internals.selectionAnchor = { row: 1, col: 5 };
	internals.selectionFocus = { row: 1, col: 7 };
	await tui.copyActiveSelectionToClipboard();
	expect(copied[1]).toBe("ell");
});

test("main-screen prompt text has no copied frame or prompt glyph", () => {
	const target = editor();
	target.setText("hello\nworld");
	const lines = target.render(80);
	expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│❯─]/);
	expect(lines[1]!.startsWith("hello")).toBe(true);
	expect(lines[2]!.startsWith("world")).toBe(true);
});

test("expanding pasted source does not reinterpret literal markers as other pastes", () => {
	const target = editor();
	paste(target, "z".repeat(1100));
	target.insertTextAtCursor("\n");
	const source = `${long}\n[ paste example ] [paste #1 1100 chars] [paste #2]`;
	paste(target, source);
	const before = target.getExpandedText();
	paste(target, source);
	expect(target.getExpandedText()).toBe(before);
	paste(target, source);
	expect(target.getExpandedText()).toBe(before);
});

test("a programmatically restored draft starts a new paste sequence", () => {
	const target = editor();
	paste(target, long); paste(target, long);
	target.setText(long);
	paste(target, long);
	expect(target.getExpandedText()).toBe(long + long);
});
