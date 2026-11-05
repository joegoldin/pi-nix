// Exercise the shipped widget factory, not a duplicate of its click policy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
const source = readFileSync(join(process.argv[2], "dist/index.js"), "utf8");
const start = source.indexOf('  function mountLensWidget(ui, mode) {');
const end = source.indexOf('  function unmountLensWidget(ui)', start);
assert(start >= 0 && end > start, "widget factory extraction");
let component;
let paints = 0;
const context = vm.createContext({
  supportsTuiWidget: () => true, getLensFlag: () => false,
  scheduleStaleReconcile() {}, setRenderCallback() {},
  hostPorts: { render: { invalidate() {} } },
  renderWidget: (_width, _theme, opts) => opts.compact ? ["◇ lens 2E !35W"] : ["lens 2E !35W", "files", "diagnostics"],
});
vm.runInContext(source.slice(start, end), context);
context.mountLensWidget({ setWidget(_key, factory) { component = factory({ requestRender() { paints++; } }, {}); } }, "tui");
assert.equal(component.render(80).length, 1, "lens must start collapsed");
assert.equal(component.handleMouse({ type: "click", button: "right" }), undefined);
assert.equal(component.render(80).length, 1);
assert.equal(component.handleMouse({ type: "click", button: "left" }).handled, true);
assert.equal(component.render(80).length, 3, "left click reveals details");
component.handleMouse({ type: "click", button: "left" });
assert.equal(component.render(80).length, 1, "second click collapses details");
assert(paints >= 2);
console.log("PASS lens starts collapsed and toggles details by click");

// The collapsed renderer must keep severity totals without leaking file rows.
const renderStart = source.indexOf("function renderWidget(width, theme, opts) {");
const renderEnd = source.indexOf("function classifyFileTier(", renderStart);
assert(renderStart >= 0 && renderEnd > renderStart);
const fixture = [{ diagnosticCounts: { blocking: 2, errors: 2, warnings: 35 } }];
Object.assign(context, {
  HORIZONTAL_MIN_WIDTH: 80, files: new Map([["a.ts", fixture[0]]]), lspServers: new Map(), sessionLanguages: ["typescript"],
  dedupeByBasename: value => value, shouldRenderFile: () => true, sortByTierThenRecency: value => value,
  countBlockingIn: () => 2, countTotalIn: severity => severity === "error" ? 2 : 35,
  countSuppressedIn: () => 2, isPendingAnalysis: () => false,
  fitCompactHeader: (width, label, languages, chip, summary) => `${label}${languages}${chip} ${summary}`.slice(0, width),
});
vm.runInContext(source.slice(renderStart, renderEnd), context);
const theme = { fg: (_slot, text) => text };
for (const width of [12, 40, 120]) {
  const rows = context.renderWidget(width, theme, { compact: true });
  assert.equal(rows.length, 1);
  assert(!rows[0].includes("typescript"));
  assert(rows[0].length <= width);
}
const header = context.renderWidget(80, theme, { compact: true })[0];
assert(header.includes("2E") && header.includes("35W"), header);
console.log("PASS collapsed lens preserves error/warning totals in one bounded row");
