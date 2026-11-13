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
  countSuppressedIn: () => 2, isPendingAnalysis: () => false, isUncheckedClean: () => false,
  visibleWidth: text => text.length, fitLine: (text, width) => text.slice(0, width),
});
vm.runInContext(source.slice(source.indexOf("function fitCompactHeader("), renderEnd), context);
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

// Run the actual renderer through the actual widget. A quiet-but-ready LSP
// used to show a compact control and then remove that control on expansion.
context.files = new Map();
context.lspServers = new Map([["typescript", { status: "ready" }]]);
context.sessionLanguages = [];
Object.assign(context, {
  countBlockingIn: () => 0, countTotalIn: () => 0, countSuppressedIn: () => 0,
  fitLine: (text, width) => text.slice(0, width),
  packHorizontalRow: () => "",
});
let expanded = false;
context.mountLensWidget({
  getToolsExpanded: () => expanded,
  setWidget(_key, factory) { component = factory({ requestRender() { paints++; } }, theme); },
}, "tui");
const compactQuiet = component.render(80);
assert.equal(compactQuiet.length, 1);
component.handleMouse({ type: "click", button: "left" });
assert.equal(component.render(80).length, 1, "quiet Lens must keep a visible collapse control");
component.handleMouse({ type: "click", button: "left" });
assert.deepEqual(Array.from(component.render(80)), Array.from(compactQuiet));

context.sessionLanguages = ["typescript"];
assert.equal(component.render(80).length, 1);
expanded = true;
assert(component.render(80)[0].includes("typescript"), "Ctrl+O expands Lens details");
expanded = false;
assert(!component.render(80)[0].includes("typescript"), "Ctrl+O restores compact Lens");
console.log("PASS quiet Lens retains its control and follows global expansion");

let notifyRender;
let invalidations = 0;
context.setRenderCallback = callback => { notifyRender = callback; };
context.hostPorts.render.invalidate = () => { invalidations++; };
context.mountLensWidget({
  getToolsExpanded: () => expanded,
  setWidget(_key, factory) { component = factory({ requestRender() { paints++; } }, theme); },
}, "tui");
component.invalidate();
notifyRender();
assert.equal(invalidations, 1, "theme/global invalidation must not disconnect diagnostic updates");
console.log("PASS Lens keeps its update subscription across invalidation");

const inline = vm.runInContext('globalThis[Symbol.for("pi.inline-status-widgets.v1")]', context);
assert(inline, "Lens publishes an inline-widget bridge");
const consumer = {};
inline.consumers.add(consumer);
const chip = inline.widgets.get("pi-lens");
assert(chip && chip.render(80, theme).includes("◇ lens"));
assert.equal(component.render(80).length, 0, "embedded compact Lens costs no standalone row");
chip.handleMouse({ type: "click", button: "left" });
assert(component.render(80).length > 0, "the dashboard chip opens Lens details");
chip.handleMouse({ type: "click", button: "left" });
assert.equal(component.render(80).length, 0, "the dashboard chip folds Lens details");
expanded = true;
assert(component.render(80).length > 0, "Ctrl+O expands embedded Lens");
expanded = false;
assert.equal(component.render(80).length, 0);
context.sessionLanguages = [];
chip.handleMouse({ type: "click", button: "left" });
assert.equal(component.render(80).length, 0, "an empty expanded Lens does not duplicate the inline chip");
assert(chip.render(80, theme).includes("◇ lens"), "quiet expanded Lens keeps its inline collapse control");
inline.consumers.delete(consumer);
assert.equal(component.render(80).length, 1, "without a dashboard Lens keeps a standalone control");
component.dispose();
assert(!inline.widgets.has("pi-lens"), "disposing Lens removes its inline chip");
console.log("PASS Lens embeds its compact chip and keeps standalone fallback");

// Exercise the actual statusline footer against the actual Lens renderer and
// click handler. Neither load order may cost a standalone compact Lens row.
if (process.argv[3]) {
  const root = process.argv[3];
  const { installStatusline } = await import(join(root, "extension/src/component.ts"));
  const { parseSnapshot } = await import(join(root, "extension/src/snapshot.ts"));
  const { visibleWidth, truncateEnd } = await import(join(root, "extension/src/width.ts"));
  context.visibleWidth = visibleWidth;
  context.fitLine = truncateEnd;
  const sharedKey = Symbol.for("pi.inline-status-widgets.v1");
  const previous = globalThis[sharedKey];
  globalThis[sharedKey] = inline;
  const paintTheme = { fg: (_slot, text) => `\x1b[36m${text}\x1b[39m` };
  const snapshot = parseSnapshot(readFileSync(join(root, "extension/testdata/snapshot-full.json"), "utf8"));
  snapshot.config = { ...snapshot.config, row1: ["model"], row2: [], row3: [], row4: [], activityRows: 0, padding: 0 };
  snapshot.widgets = { model: { visible: true, spans: [{ kind: "text", text: "GPT-6.1 Sol medium" }] } };
  try {
    for (const lensFirst of [true, false]) {
      let footer;
      expanded = false;
      context.sessionLanguages = ["typescript"];
      const mount = () => context.mountLensWidget({
        getToolsExpanded: () => expanded,
        setWidget(_key, factory) { component = factory({ requestRender() { paints++; } }, paintTheme); },
      }, "tui");
      if (lensFirst) mount();
      const handle = installStatusline({ mode: "tui", hasUI: true, ui: {
        setStatus() {}, setWidget() {}, setFooter(factory) {
          footer?.dispose?.();
          footer = factory?.({ requestRender() { paints++; } }, paintTheme, {
            getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
          });
        },
      } }, {});
      handle.setSnapshot(snapshot);
      if (!lensFirst) mount();
      try {
        for (const width of [32, 80, 120]) {
          assert.equal(component.render(width).length, 0);
          const rows = footer.render(width);
          const y = rows.findIndex(row => row.includes("◇ lens"));
          assert(y >= 0, "the dashboard contains the real Lens chip");
          if (width >= 80) assert.equal(y, 0, "Lens shares the left identity row");
          const x = visibleWidth(rows[y].slice(0, rows[y].indexOf("◇ lens")));
          assert.equal(footer.handleMouse({ type: "click", button: "left", x, y }).handled, true);
          assert(component.render(width).length > 0);
          footer.handleMouse({ type: "click", button: "left", x, y });
          assert.equal(component.render(width).length, 0);
          expanded = true;
          assert(component.render(width).length > 0);
          expanded = false;
        }
      } finally { handle.dispose(); component.dispose(); }
      assert.equal(inline.consumers.size, 0, "footer disposal releases the inline consumer");
    }
  } finally { globalThis[sharedKey] = previous; }
  console.log("PASS real Lens and statusline pack, wrap, click and expand in either load order");
}
