import { expect, test } from "bun:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, ScrollView, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { Framed } from "./frame.ts";
import { createPromptEditor } from "./editor.ts";

const identity = (text: string) => text;
function prompt(text: string, columns = 24, rows = 80) {
	const copied: string[] = [];
	const terminal = { columns, rows, write() {}, hideCursor() {}, showCursor() {}, moveBy() {}, setCursorPosition() {}, clearLine() {}, clearFromCursor() {} };
	const tui = new TuiAltScreen(terminal as never, false, undefined, { copySelection: async text => { copied.push(text); return true; } });
	tui.requestRender = () => {};
	const Prompt = createPromptEditor(CustomEditor as never, () => identity);
	const target = new Prompt(tui, { borderColor: identity, selectList: {} }, { matches: () => false }) as unknown as CustomEditor;
	target.setText(text);
	tui.setLayoutRoot(target);
	const native = tui as any;
	native.stopped = false; native.altScreenActive = true; native.doRender();
	return {
		target, tui, native, copied,
		async copy(start = { row: 0, col: 0 }, end = { row: target.render(columns).length - 1, col: columns - 1 }) {
			native.selectionAnchor = start; native.selectionFocus = end;
			await tui.copyActiveSelectionToClipboard();
			return copied.at(-1);
		},
	};
}

test("prompt copying rejoins visual wraps without losing real newlines, indentation or whitespace", async () => {
	const text = "  alpha beta gamma delta epsilon  \n\n  literal │ and ❯ symbols, 界 é 🙂\n";
	expect(await prompt(text).copy()).toBe(text);
});

test("partial selections across a forced word wrap do not add spaces or newlines", async () => {
	const text = "abcdefghijklmnopqrstuvwxyz0123456789";
	const p = prompt(text, 20);
	expect(await p.copy({ row: 1, col: 6 }, { row: 2, col: 7 })).toBe(text.slice(2, 16));
	expect(await p.copy({ row: 2, col: 7 }, { row: 1, col: 6 })).toBe(text.slice(2, 16));
});

test("scrolled prompt copying uses the visible source offsets, not the beginning of the draft", async () => {
	const text = "abcdefghij".repeat(20);
	const p = prompt(text, 24, 10);
	const native = p.target as any;
	const map = native.buildVisualLineMap(native.lastWidth);
	expect(native.scrollOffset).toBeGreaterThan(0);
	expect(await p.copy()).toBe(text.slice(map[native.scrollOffset].startCol));
});

const markdownTheme = Object.fromEntries(["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"].map(key => [key, identity]));
async function copyConversation(component: any, columns = 28, rows = 6, selection?: { start: { row: number; col: number }; end: { row: number; col: number } }) {
	const p = prompt("", columns, rows);
	const scroll = new ScrollView(component, { follow: "end", scrollbar: "always" });
	p.tui.setLayoutRoot(scroll); p.native.doRender();
	const lines = p.native.currentLayout.root.scrollContentLines;
	p.native.selectionAnchor = { ...(selection?.start ?? { row: 0, col: 0 }), scrollView: scroll };
	p.native.selectionFocus = { ...(selection?.end ?? { row: lines.length - 1, col: columns - 2 }), scrollView: scroll };
	const displayed = (TuiAltScreen.prototype as any).getActiveSelectionText.call(p.tui);
	await p.tui.copyActiveSelectionToClipboard();
	return { text: p.copied.at(-1), displayed, scrollTop: scroll.scrollTop };
}

test("conversation copying joins Text soft wraps but preserves tool-output lines and message boundaries", async () => {
	const text = "  a very long tool output line with spacing  and a URL https://example.com/abcdefghijklmnopqrstuvwxyz\nnext real line\n\nlast line";
	const document = new Container(); const box = new Box(2, 0);
	box.addChild(new Text(text, 1, 0)); document.addChild(box);
	document.addChild(new Text("separate message", 1, 0));
	const copied = await copyConversation(document);
	expect(copied.scrollTop).toBeGreaterThan(0);
	expect(copied.text).toBe(`${text}\nseparate message`);
});

test("assistant Markdown copying retains rendered formatting and code newlines without visual wraps", async () => {
	const text = "A **long paragraph** with enough words to wrap across several screen rows.\n\n- a long list item with enough words to wrap onto another row\n\n```ts\n  const longName = 'abcdefghijklmnopqrstuvwxyz0123456789';\n  second();\n```";
	const markdown = new Markdown(text, 1, 0, markdownTheme as never);
	const expected = new Markdown(text, 0, 0, markdownTheme as never).render(180).map(line => line.trimEnd()).join("\n");
	expect((await copyConversation(markdown)).text).toBe(expected);
});

test("owned tool frames are excluded, while identical characters in the tool payload remain", async () => {
	const text = "literal │ and ❯ data in a very long output line, not UI decoration\n  indented result";
	const inner = new Text(text, 0, 0);
	const framed = new Framed(inner, "Tool result", { fg: (_slot: string, value: string) => value, bold: identity } as never);
	expect((await copyConversation(framed)).text).toBe(text);
});

test("partial conversation selections join only selected fragments, including wide graphemes", async () => {
	const text = new Text("界🙂abcdefghijklmnopqrstuv", 1, 0);
	// The native wrapper puts 界 on its own row; begin inside the emoji's second cell.
	const selection = { start: { row: 1, col: 2 }, end: { row: 2, col: 4 } };
	expect((await copyConversation(text, 14, 6, selection)).text).toBe("🙂abcdefghijklm");
});

test("custom tool payload borders and deliberate newlines are not guessed to be UI chrome", async () => {
	const custom = { render: () => ["│ actual payload │", "  hard line one", "  hard line two"], invalidate() {} };
	const copied = await copyConversation(custom);
	expect(copied.text).toBe(copied.displayed);
	expect(copied.text).toContain("│ actual payload │");
});

test("framed custom output copies only visible truncation, never hidden content", async () => {
	const custom = { render: () => ["x".repeat(100) + "hidden"], invalidate() {} };
	const framed = new Framed(custom, "Result", { fg: (_slot: string, value: string) => value, bold: identity } as never);
	expect((await copyConversation(framed)).text).toBe(`${"x".repeat(22)}…`);
});

test("Markdown copying does not rerun source transforms or change the live render cache", async () => {
	let transforms = 0;
	const markdown = new Markdown("unused", 1, 0, markdownTheme as never, undefined, {
		transform: () => { transforms++; return "A long transformed paragraph which wraps over several rows in the conversation."; },
	});
	const copied = await copyConversation(markdown);
	expect(copied.text).toBe("A long transformed paragraph which wraps over several rows in the conversation.");
	expect(transforms).toBe(1);
	expect((markdown as any).cachedWidth).toBe(27);
});

test("copying a height-clipped editor respects the native layout line offset", async () => {
	const text = "abcdefghij".repeat(20);
	const p = prompt(text, 24, 10);
	p.tui.setFocus(p.target);
	p.tui.setLayoutRoot(new VStack([{ component: p.target, basis: 3, shrink: 0 }]));
	p.native.doRender();
	const box = p.native.currentLayout.root.children[0];
	const editor = p.target as any;
	const map = editor.buildVisualLineMap(editor.lastWidth);
	expect(box.lineOffset).toBeGreaterThan(0);
	expect(await p.copy({ row: box.rect.y, col: 0 }, { row: box.rect.y + 2, col: 23 })).toBe(text.slice(map[editor.scrollOffset + box.lineOffset - 1].startCol));
});

test("copying dictation omits the meter cell even when it changes wrapping in the middle of a draft", async () => {
	const p = prompt("before AFTER with a long untouched suffix", 24);
	const editor = p.target as any;
	editor.setCursorCol(7);
	const speech = editor.beginDictation(() => {});
	speech.update({ committed: "a long dictated phrase", partial: "preview", level: 0.8 });
	p.native.doRender();
	expect(await p.copy()).toBe(p.target.getText());
	const row = p.target.render(24).findIndex((_line, index) => editor.dictationMeterColumn(index) !== undefined);
	expect(await p.copy({ row, col: editor.dictationMeterColumn(row) + 1 })).toBe(p.target.getText().slice(p.target.getCursor().col));
	speech.finish();
});

test("an overlay's literal frame characters are not stripped as editor decoration", async () => {
	const p = prompt("original");
	p.native.previousScreen[1] = "│ overlay text │".padEnd(24);
	expect(await p.copy()).toBe("│ overlay text │");
});

test("default live tool cards copy logical output without their bullet, elbow or padding", async () => {
	const { cardRenderers } = await import("./render.ts");
	const { DEFAULTS } = await import("./config.ts");
	const theme = { fg: (_slot: string, text: string) => text, bold: identity, italic: identity };
	const renderers = cardRenderers("bash", { config: () => ({ ...DEFAULTS, groupRuns: false }), highlight: code => code.split("\n"), languageOf: () => undefined, expandKey: () => "ctrl+o" });
	const context = { args: { command: "echo result" }, toolCallId: "copy", state: {}, cwd: "/repo", expanded: true, isPartial: false, isError: false, outputPad: 2 };
	const output = "  a very long tool line with literal │ and ❯ data, preserved across soft wraps\nnext actual line";
	renderers.renderResult!({ content: [{ type: "text", text: output }] }, { expanded: true, isPartial: false }, theme, context);
	const component = renderers.renderCall!(context.args, theme, context);
	const copied = await copyConversation(component);
	expect(copied.text).toContain(output);
	expect(copied.text).toStartWith("Bash(echo result)");
	expect(copied.text).not.toContain("⎿");
});

test("native assistant and self-rendered tool shells retain selection metadata through transcript composition", async () => {
	const load = (name: string) => import(new URL(`./modes/interactive/${name}.js`, import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const { initTheme } = await load("theme/theme"); initTheme("dark", false);
	const { AssistantMessageComponent } = await load("components/assistant-message");
	const { ToolExecutionComponent } = await load("components/tool-execution");
	const { cardRenderers } = await import("./render.ts");
	const { DEFAULTS } = await import("./config.ts");
	const text = "A long actual assistant paragraph which must survive multiple soft wraps without newlines.";
	const document = new Container();
	document.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }, false, markdownTheme));
	const renderers = cardRenderers("bash", { config: () => ({ ...DEFAULTS, groupRuns: false }), highlight: code => code.split("\n"), languageOf: () => undefined, expandKey: () => "ctrl+o" });
	const tool = new ToolExecutionComponent("bash", "copy-shell", { command: "echo result" }, { outputPad: 2 }, renderers, prompt("").tui, "/repo");
	const output = "  a long actual shell result with literal │ content and intentional indentation\nnext line";
	tool.updateResult({ content: [{ type: "text", text: output }], isError: false }); tool.setExpanded(true);
	document.addChild(tool);
	const copied = await copyConversation(document);
	expect(copied.text).toContain(text);
	expect(copied.text).toContain(output);
	expect(copied.text).not.toContain("⎿");
	expect(copied.text).not.toContain("● Bash");
});
