// Exercise the shipped widget and shortcut registration, not a duplicate of their policy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
const source = readFileSync(join(process.argv[2], "dist/index.js"), "utf8");
const start = source.indexOf('  let lensWidgetVisible = globalConfig?.widget?.visible !== false;');
const end = source.indexOf('  if (typeof pi.registerMessageRenderer === "function") {', start);
assert(start >= 0 && end > start, "widget and shortcut extraction");
let component;
let paints = 0;
let shortcut;
const context = vm.createContext({
  globalConfig: undefined,
  pi: { registerShortcut(key, spec) { assert.equal(key, "ctrl+shift+l"); shortcut = spec.handler; } },
  supportsTuiWidget: () => true,
  scheduleStaleReconcile() {}, setRenderCallback() {},
  hostPorts: { render: { invalidate() {} } },
  renderWidget: (_width, _theme, opts) => opts.compact ? ["◇ lens 2E !35W"] : ["lens 2E !35W", "files", "diagnostics"],
});
vm.runInContext(source.slice(start, end), context);
assert.equal(typeof shortcut, "function");
const press = async () => await shortcut();
const mount = (theme = {}, getToolsExpanded = () => false) => {
  context.mountLensWidget({ getToolsExpanded, setWidget(_key, factory) { component = factory({ requestRender() { paints++; } }, theme); } }, "tui");
};
await press(); // A hidden or unavailable widget has nothing to toggle.
mount();
assert.equal(component.render(80).length, 1, "lens must start collapsed");
assert.equal(component.handleMouse, undefined, "the standalone widget no longer toggles by click");
await press();
assert.equal(component.render(80).length, 3, "Ctrl+Shift+L reveals details");
await press();
assert.equal(component.render(80).length, 1, "Ctrl+Shift+L collapses details");
assert(paints >= 2);
component.dispose();
console.log("PASS lens starts collapsed and toggles details by keyboard");

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

// A quiet-but-ready LSP still has only one visible surface when toggled.
context.files = new Map();
context.lspServers = new Map([["typescript", { status: "ready" }]]);
context.sessionLanguages = [];
Object.assign(context, {
  countBlockingIn: () => 0, countTotalIn: () => 0, countSuppressedIn: () => 0,
  fitLine: (text, width) => text.slice(0, width),
  packHorizontalRow: () => "",
});
let expanded = false;
let notifyRender;
let invalidations = 0;
context.setRenderCallback = callback => { notifyRender = callback; };
context.hostPorts.render.invalidate = () => { invalidations++; };
mount(theme, () => expanded);
component.invalidate();
notifyRender();
assert.equal(invalidations, 1, "theme/global invalidation must not disconnect diagnostic updates");

const inline = vm.runInContext('globalThis[Symbol.for("pi.inline-status-widgets.v1")]', context);
assert(inline, "Lens publishes an inline-widget bridge");
const consumer = {};
inline.consumers.add(consumer);
const chip = inline.widgets.get("pi-lens");
assert(chip && chip.render(80, theme).includes("◇ lens"));
assert.equal(chip.handleMouse, undefined, "the inline chip no longer toggles by click");
assert.equal(component.render(80).length, 0, "embedded compact Lens costs no standalone row");
await press();
assert.equal(chip.render(80, theme), "", "quiet expanded Lens has no inline copy");
assert.equal(component.render(80).length, 1, "quiet Lens still has a standalone summary");
await press();
assert.equal(component.render(80).length, 0);
context.sessionLanguages = ["typescript"];
expanded = true;
assert(component.render(80)[0].includes("typescript"), "Ctrl+O still expands Lens details");
assert.equal(chip.render(80, theme), "", "global expansion also hides the inline copy");
await press();
assert.equal(component.render(80).length, 0, "the Lens key can collapse after Ctrl+O");
assert(chip.render(80, theme).includes("◇ lens"));
expanded = false;
inline.consumers.delete(consumer);
assert.equal(component.render(80).length, 1, "without a dashboard Lens keeps a standalone summary");
component.dispose();
assert(!inline.widgets.has("pi-lens"), "disposing Lens removes its inline chip");
const paintsAfterDispose = paints;
await press();
assert.equal(paints, paintsAfterDispose, "disposing Lens disconnects the shortcut from its widget");
console.log("PASS Lens surfaces are mutually exclusive and clean up on disposal");

// Exercise the actual statusline footer against the actual Lens renderer and
// shortcut. Neither load order may cost a standalone compact Lens row.
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
  snapshot.widgets = { model: { visible: true, spans: [{ kind: "text", text: "GPT-6.2 Sol medium" }] } };
  try {
    for (const lensFirst of [true, false]) {
      let footer;
      expanded = false;
      context.sessionLanguages = ["typescript"];
      const mountWidget = () => mount(paintTheme, () => expanded);
      if (lensFirst) mountWidget();
      const handle = installStatusline({ mode: "tui", hasUI: true, ui: {
        setStatus() {}, setWidget() {}, setFooter(factory) {
          footer?.dispose?.();
          footer = factory?.({ requestRender() { paints++; } }, paintTheme, {
            getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
          });
        },
      } }, {});
      handle.setSnapshot(snapshot);
      if (!lensFirst) mountWidget();
      try {
        for (const width of [32, 80, 120]) {
          assert.equal(component.render(width).length, 0);
          const rows = footer.render(width);
          const y = rows.findIndex(row => row.includes("◇ lens"));
          assert(y >= 0, "the dashboard contains the real Lens chip");
          if (width >= 80) assert.equal(y, 0, "Lens shares the left identity row");
          const x = visibleWidth(rows[y].slice(0, rows[y].indexOf("◇ lens")));
          assert.equal(footer.handleMouse({ type: "click", button: "left", x, y }), undefined);
          assert.equal(component.render(width).length, 0);
          await press();
          assert(component.render(width).length > 0);
          assert(!footer.render(width).some(row => row.includes("◇ lens")));
          await press();
          assert.equal(component.render(width).length, 0);
          assert(footer.render(width).some(row => row.includes("◇ lens")));
        }
      } finally { handle.dispose(); component.dispose(); }
      assert.equal(inline.consumers.size, 0, "footer disposal releases the inline consumer");
    }
  } finally { globalThis[sharedKey] = previous; }
  console.log("PASS real Lens and statusline pack, wrap and toggle in either load order");
}
