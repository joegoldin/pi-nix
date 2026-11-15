import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const extension = process.argv[3] ?? "js";
const load = (path) => import(pathToFileURL(`${root}/${path}.${extension}`).href);
const { TuiAltScreen } = await load("tui-alt-screen");
const { Text } = await load("components/text");
const { Markdown } = await load("components/markdown");
const { stripTerminalSequences, visibleWidth, withCopyTracking, isCopyTrackingEnabled } = await load("utils");

const render = (text, width = 24) => withCopyTracking(() => text.render(width));

const clipboard = [];
const tui = new TuiAltScreen({ columns: 24, rows: 80, write() {} }, undefined, undefined, {
  copySelection: async (text) => { clipboard.push(text); return true; },
});
tui.flash = () => {};

function select(lines, start = { row: 0, col: 2 }, end = { row: lines.length - 1, col: 24 }) {
  tui.previousScreen = lines;
  tui.selectionAnchor = start;
  tui.selectionFocus = end;
  return tui.getActiveSelectionText();
}

const url = "https://auth.example.test/authorize?client_id=pi&code_challenge_method=S256&scope=openid%20profile";
const wrappedUrl = render(new Text(url, 2, 0));
assert.equal(select(wrappedUrl), url, "soft wrapping must not insert whitespace into URLs");
assert.equal(await tui.copyActiveSelectionToClipboard(), true);
assert.equal(clipboard.at(-1), url, "the configured clipboard receives the original URL");

for (const source of [
  "a real space at a word boundary must survive",
  "  real leading indentation must remain when text wraps",
  "multiple   spaces    at wrapping boundaries survive too",
  "abcdefghijklmnopqrst abcdefghijklmnopqrst",
  "abcdefghijklmnopqrstabcdefghijklmnopqrst",
  "first paragraph wraps across the display\nsecond paragraph also wraps across the display",
  "short line\nnext line wraps across the display and keeps its spaces",
  "a long paragraph that wraps and has trailing spaces   \nnext paragraph",
  "first paragraph wraps across the display\n\nlast paragraph preserves the empty line",
  "漢字の長い文章は画面の端で折り返しても空白を追加しません",
  "emoji 👩‍💻 and e\u0301 characters remain intact when text wraps",
]) {
  const lines = render(new Text(source, 2, 0));
  assert.equal(select(lines), source, JSON.stringify(source));
  assert.equal(select(lines, { row: lines.length - 1, col: 24 }, { row: 0, col: 2 }), source,
    "backward selections preserve the same source text");
  assert.ok(lines.every((line) => visibleWidth(line) === 24), "metadata must not affect display width");
}

const styled = render(new Text(`\x1b[31m${url}\x1b[0m`, 2, 0));
assert.equal(select(styled), url, "styling never enters copied text");
assert.equal(select(render(new Text(url, 2, 0, (text) => `\x1b[44m${text}\x1b[49m`))), url,
  "background padding is not source text");
const linked = render(new Text(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`, 2, 0));
assert.equal(select(linked), url, "OSC 8 hyperlinks retain exact URL text");
assert.equal(select(wrappedUrl, { row: 1, col: 2 }, { row: 2, col: 7 }), url.slice(20, 46),
  "partial selections copy only the selected graphemes");
assert.equal(select(["literal first line", "literal second line"], { row: 0, col: 0 }, { row: 1, col: 18 }),
  "literal first line\nliteral second line", "unannotated lines retain explicit newlines");
assert.ok(!stripTerminalSequences(wrappedUrl.join("")).includes("pi:copy"), "metadata is non-printing");
const theme = Object.fromEntries([
  "heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet",
  "bold", "italic", "strikethrough", "underline",
].map((key) => [key, (text) => text]));
assert.equal(select(render(new Markdown(url, 2, 0, theme))), url, "Markdown URLs also copy without visual wraps");
const paragraph = "real   spaces in a long paragraph must survive the display wrapping";
assert.equal(select(render(new Markdown(paragraph, 2, 0, theme))), paragraph);
assert.equal(select(render(new Markdown(`- ${paragraph}`, 2, 0, theme))), `- ${paragraph}`,
  "a genuine list bullet remains, but continuation indentation does not");
const text = new Text(url, 2, 0);
for (const width of [12, 24, 60, 120, 24]) {
  const lines = render(text, width);
  assert.equal(select(lines, { row: 0, col: 2 }, { row: lines.length - 1, col: width }), url,
    `copy remains exact after resizing to ${width} columns`);
}
assert.equal(text.render(24).some((line) => line.includes("pi:copy")), false,
  "returning to ordinary rendering must not reuse a fullscreen cache");
assert.equal(select(render(text)), url, "fullscreen rendering must not reuse an ordinary cache");
for (const payload of ["not-json", "[]", '["wrong",0,""]', '[1,0,"hidden text"]']) {
  const line = `\x1b_pi:copy-start\x1b\\safe\x1b_pi:copy-end;${payload}\x1b\\`;
  assert.equal(select([line, "tail"], { row: 0, col: 0 }, { row: 1, col: 24 }), "safe\ntail",
    "invalid provenance falls back to literal rows without copying hidden payloads");
}
const other = "https://other.example.test/a-different-long-url-to-wrap";
assert.equal(select([wrappedUrl[0], render(new Text(other, 2, 0))[1]]), `${url.slice(0, 20)}\n${other.slice(20, 40)}`,
  "unrelated wrapped regions must not be silently joined");
assert.throws(() => withCopyTracking(() => { throw new Error("render failure"); }), /render failure/);
assert.equal(isCopyTrackingEnabled(), false, "render failures must restore ordinary rendering mode");
console.log("selection copy regressions passed");
