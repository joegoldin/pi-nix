// Test the shipped UI and both live/history rendering paths without a terminal.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const modules = process.argv[2];
assert(modules, "usage: user-message-timestamps <pi node_modules>");
const load = (path) => import(pathToFileURL(`${modules}/${path}`).href);
const { Container, stripTerminalSequences, visibleWidth } = await load("@earendil-works/pi-tui/dist/index.js");
const { initTheme, getMarkdownTheme } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
const { UserMessageComponent } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js");
const { InteractiveMode } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js");
initTheme("dark", false);
process.env.TZ = "UTC";
const timestamp = Date.parse("2026-10-19T16:24:00Z");
const component = new UserMessageComponent("A user message", getMarkdownTheme(), 1, [], timestamp);
const plain = (rows) => rows.map(stripTerminalSequences);
const rows = component.render(50);
assert(plain(rows)[0].endsWith("4:24 PM "));
assert(rows[0].startsWith("\x1b]133;A;pi=user\x07"));
assert(rows.at(-1).startsWith("\x1b]133;B\x07\x1b]133;C\x07"));
assert(plain(rows).some(row => row.includes("A user message")));
const legacy = new UserMessageComponent("A user message");
assert.equal(rows.length, legacy.render(50).length, "timestamp uses existing padding, not an extra row");
assert(!plain(legacy.render(50)).join("\n").includes("PM"));
for (const width of [1, 5, 8, 10, 20, 50]) {
  const rendered = component.render(width);
  const withoutTime = legacy.render(width);
  assert(visibleWidth(rendered[0]) <= width, "timestamp stays within the viewport");
  // Markdown itself overflows its padding at width 1. Timestamp rendering must
  // neither widen those rows nor change their content to make room for metadata.
  assert.deepEqual(rendered.slice(1), withoutTime.slice(1));
  assert.deepEqual(rendered.map(visibleWidth), withoutTime.map(visibleWidth));
}
component.setOutputPad(2);
assert(plain(component.render(50))[0].endsWith("4:24 PM  "));
assert(!plain(new UserMessageComponent("old", getMarkdownTheme(), 1, [], NaN).render(50)).join("\n").includes("Invalid"));
process.env.TZ = "America/Los_Angeles";
assert(plain(component.render(50))[0].includes("9:24 AM"), "time is local, not fixed UTC");
process.env.TZ = "UTC";
for (const text of ["history message", '<skill name="demo" location="/tmp/SKILL.md">\nSkill text\n</skill>\n\nuser guidance']) {
  const ctx = {
    chatContainer: new Container(), outputPad: 1, messageComponents: new WeakMap(),
    getUserMessageText: () => text,
    getMarkdownThemeWithSettings: getMarkdownTheme,
    getMarkdownTransformers: () => [],
  };
  const message = { role: "user", content: text, timestamp };
  InteractiveMode.prototype.addMessageToChat.call(ctx, message);
  const user = ctx.chatContainer.children.find(child => child instanceof UserMessageComponent);
  assert(user, "user component rendered");
  assert(plain(user.render(50))[0].includes("4:24 PM"), "stored message time reaches the component");
  assert.deepEqual(message, { role: "user", content: text, timestamp }, "rendering does not alter model input");
}
console.log("User timestamps: stored time, local zone, narrow widths, history/skills and prompt markers pass.");
