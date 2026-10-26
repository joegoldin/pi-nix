import { expect, test } from "bun:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";
import { createPromptEditor } from "./editor.ts";

const colours = { text: 37, dim: 90, success: 32, warning: 33, error: 31 };
const colour = (slot: keyof typeof colours, text: string) => `\x1b[${colours[slot]}m${text}\x1b[39m`;
function editor() {
	let interrupted = 0;
	const Editor = createPromptEditor(CustomEditor as never, () => (text) => text, true, colour);
	const target = new Editor({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, { borderColor: (text: string) => text, selectList: {} }, { matches: () => false });
	const start = () => target.beginDictation(() => { interrupted++; });
	return { target, start, interruptions: () => interrupted };
}

test("dictation is editable text with white commits, gray revisions and a height/colour VU cursor", () => {
	const { target, start } = editor();
	const voice = start();
	voice.update({ committed: "Hello", partial: "wor", level: 0 });
	expect(target.getText()).toBe("Hello wor");
	let rows = target.render(80).join("\n");
	expect(rows).toContain(colour("text", "Hello"));
	expect(rows).toContain(colour("dim", "wor"));
	expect(rows).toContain(colour("success", "▁"));
	expect(rows).not.toContain(renderFakeCursor(" "));
	expect(rows).not.toContain(CURSOR_MARKER);
	voice.update({ committed: "Hello", partial: "world", level: 0.75 });
	expect(target.getText()).toBe("Hello world");
	expect(target.render(80).join("\n")).toContain(colour("warning", "▆"));
	voice.update({ committed: "Hello world", partial: "", level: 1 });
	expect(target.render(80).join("\n")).toContain(colour("error", "█"));
	voice.finish("Hello, world!");
	expect(target.getText()).toBe("Hello, world!");
	expect(target.render(80).join("\n")).toContain(renderFakeCursor(" "));
});

test("dictation revises only its insertion and is one undo step, without collapsing long speech", () => {
	const { target, start } = editor();
	target.setText("before  after");
	for (let i = 0; i < 6; i++) target.handleInput("\x1b[D");
	const voice = start();
	voice.update({ committed: "hello", partial: "worl", level: 0.5 });
	expect(target.getText()).toBe("before hello worl after");
	const final = "你好 👩🏽‍💻 words ".repeat(100).trim();
	voice.finish(final);
	expect(target.getText()).toBe(`before ${final} after`);
	expect(target.getText()).not.toContain("[paste #");
	target.handleInput("\x1f");
	expect(target.getText()).toBe("before  after");
});

test("Unicode and multiline provisional text wrap and scroll inside the existing editor", () => {
	const { target, start } = editor();
	const voice = start();
	const committed = "你好 👩🏽‍💻 é hello\n".repeat(15).trim();
	voice.update({ committed, partial: "last words", level: 0.5 });
	for (const width of [1, 5, 16, 40, 80]) {
		const rows = target.render(width);
		expect(rows.length).toBeLessThanOrEqual(10);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		expect(rows.join("\n")).not.toContain("\ufffd");
	}
	expect(target.render(40).join("\n")).toContain(colour("dim", "last words"));
	expect(target.getText()).toBe(`${committed} last words`);
});

test("typing ends dictation ownership so a late final cannot overwrite user edits", () => {
	const { target, start, interruptions } = editor();
	const voice = start();
	voice.update({ committed: "hello", partial: "world", level: 0.5 });
	target.handleInput("!");
	expect(interruptions()).toBe(1);
	voice.finish("Different final text");
	expect(target.getText()).toBe("hello world!");
});

test("Enter stops dictation without submitting, and resumes normal behavior afterward", () => {
	const { target, start, interruptions } = editor();
	let submissions = 0;
	(target as unknown as CustomEditor).onSubmit = () => { submissions++; };
	start().update({ committed: "hello", partial: "", level: 0.5 });
	target.handleInput("\r");
	expect(interruptions()).toBe(1);
	expect(submissions).toBe(0);
	expect(target.getText()).toBe("hello");
	target.handleInput("\r");
	expect(submissions).toBe(1);
});

test("queue/submit variants stop recording without modifying or submitting the draft", () => {
	for (const data of ["\x1b\r", "\x1b[13;3u", "\x1b[13;5u", "\x1b[13;2u", "\n"]) {
		const { target, start, interruptions } = editor();
		let submissions = 0;
		(target as unknown as CustomEditor).onSubmit = () => { submissions++; };
		start().update({ committed: "hello", partial: "world", level: 0.5 });
		target.handleInput(data);
		expect(interruptions()).toBe(1);
		expect(submissions).toBe(0);
		expect(target.getText()).toBe("hello world");
	}
});

test("programmatic editor replacement and cursor movement cannot be overwritten by pending speech", () => {
	for (const replace of [true, false]) {
		const { target, start, interruptions } = editor();
		const voice = start();
		voice.update({ committed: "hello", partial: "", level: 0.5 });
		if (replace) target.setText("another draft");
		else target.state.cursorCol = 0;
		voice.update({ committed: "late speech", partial: "", level: 0.5 });
		voice.finish("late final");
		expect(target.getText()).toBe(replace ? "another draft" : "hello");
		expect(interruptions()).toBe(1);
	}
});

test("key releases and terminal focus reports do not stop dictation", () => {
	const { target, start, interruptions } = editor();
	const voice = start();
	for (const data of ["\x1b[32;1:3u", "\x1b[97;1:3u", "\x1b[I", "\x1b[O"]) target.handleInput(data);
	expect(interruptions()).toBe(0);
	voice.update({ committed: "still recording", partial: "", level: 0.5 });
	expect(target.getText()).toBe("still recording");
});

test("fullscreen rendering keeps the frame and excludes the VU cell from copied text", async () => {
	const { TuiAltScreen } = await import("@earendil-works/pi-tui");
	const copied: string[] = [];
	const terminal = { columns: 80, rows: 24, stop() {}, write() {}, hideCursor() {}, showCursor() {}, moveBy() {}, setCursorPosition() {}, clearLine() {}, clearFromCursor() {} };
	const tui = new TuiAltScreen(terminal as never, false, undefined, { copySelection: async text => { copied.push(text); return true; } });
	tui.requestRender = () => {};
	const Editor = createPromptEditor(CustomEditor as never, () => text => text, true, colour);
	const target = new Editor(tui, { borderColor: (text: string) => text, selectList: {} }, { matches: () => false });
	target.setText("before  after");
	for (let i = 0; i < 6; i++) target.handleInput("\x1b[D");
	target.beginDictation(() => {}).update({ committed: "hello", partial: "world", level: 1 });
	tui.addChild(target);
	tui.setLayoutRoot(target);
	const internals = tui as any;
	internals.stopped = false;
	internals.altScreenActive = true;
	internals.doRender();
	expect(internals.previousScreen.join("\n")).toContain("╭");
	expect(internals.previousScreen.join("\n")).toContain("█");
	internals.selectionAnchor = { row: 0, col: 0 };
	internals.selectionFocus = { row: 2, col: 79 };
	await tui.copyActiveSelectionToClipboard();
	expect(copied).toEqual(["before hello world after"]);
	tui.stop();
});

test("clicking after the virtual meter places the caret on the displayed character", () => {
	const { target, start, interruptions } = editor();
	target.setText("before  after");
	for (let i = 0; i < 6; i++) target.handleInput("\x1b[D");
	const voice = start();
	voice.update({ committed: "hello", partial: "world", level: 0.5 });
	target.render(80);
	const meter = target.dictationMeterColumn(1)!;
	target.handleMouse({ type: "click", button: "left", x: meter + 2, y: 1, width: 80, height: 3 } as never);
	target.handleInput("X");
	voice.finish("late final");
	expect(target.getText()).toBe("before hello world Xafter");
	expect(interruptions()).toBe(1);
});
