{ lib }:
# pi-lens declares seven "core" tools on every request, about 2.4k tokens of
# tool definitions, and defers only its five situational ones behind
# pi_lens_activate_tools. Marking the core seven situational too puts them
# behind the same loader: pi-lens deactivates them at session start and the
# loader brings them back when the model asks. Its per-edit checks and the
# findings it injects into the next turn do not depend on these tools.
#
# --replace-fail, so an upstream reshuffle of TOOL_REGISTRY breaks the build
# instead of silently restoring the cost.
let
  core = [
    "lens_diagnostics"
    "symbol_search"
    "module_report"
    "project_report"
    "read_symbol"
    "read_enclosing"
    "effective_config"
  ];
in
{
  # The diagnostics widget draws its " pi-lens" header whenever it tracks a
  # file or an LSP server, even when there is nothing to put after it: no
  # languages, no findings, no files worth a row. That leaves a lone "pi-lens"
  # line above the footer. Use the normal summary for a quiet, expanded
  # view that has nothing else to show.
  quietEmptyWidget = ''
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "  lines.push(fitLine(header, w));\n  if (summaryFacts.totalSuppressed > 0) {"} \
      ${lib.escapeShellArg "  if (!langStr && !lspChip && !summary && summaryFacts.totalSuppressed === 0 && recencySorted.length === 0)\n    return [fitCompactHeader(w, cyan(\"◇ lens\"), \"\", lspChip, summary)];\n  lines.push(fitLine(header, w));\n  if (summaryFacts.totalSuppressed > 0) {"}
  '';

  # The dashboard consumes the compact chip when available; the native widget
  # then owns only expanded rows. One expansion state keeps the two surfaces
  # mutually exclusive, including when Pi changes global tool expansion.
  compactToggleWidget = ''
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "  let mountedLensWidgetUi;"} \
      ${lib.escapeShellArg ''
        let mountedLensWidgetUi;
        let toggleLensWidgetDetails;
        pi.registerShortcut?.("ctrl+shift+l", {
          description: "Expand or collapse Lens diagnostics",
          handler: async () => { toggleLensWidgetDetails?.(); },
        });
      ''}
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "      const compactWidget = getLensFlag(\"lens-compact-widget\") === true;"} \
      ${lib.escapeShellArg ''
        let expanded = false;
        let lastGlobalExpanded;
        const isExpanded = () => {
          const globalExpanded = ui.getToolsExpanded?.() === true;
          if (lastGlobalExpanded !== globalExpanded) {
            lastGlobalExpanded = globalExpanded;
            expanded = globalExpanded;
          }
          return expanded;
        };
        const inlineKey = Symbol.for("pi.inline-status-widgets.v1");
        const inline = globalThis[inlineKey] ??= { widgets: new Map(), consumers: new Set() };
        const toggle = () => {
          expanded = !isExpanded();
          tui.requestRender();
        };
        toggleLensWidgetDetails = toggle;
        const chip = {
          render: (width, chipTheme) => isExpanded() ? "" : renderWidget(width, chipTheme, { compact: true })[0] ?? "",
        };
        inline.widgets.set("pi-lens", chip);
      ''}
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "          return renderWidget(width, theme, { compact: compactWidget });\n        },\n        invalidate:"} \
      ${lib.escapeShellArg ''
          const compact = !isExpanded();
          if (inline.consumers.size > 0 && compact) return [];
          return renderWidget(width, theme, { compact });
        },
        dispose: () => {
          if (inline.widgets.get("pi-lens") === chip) inline.widgets.delete("pi-lens");
          if (toggleLensWidgetDetails === toggle) toggleLensWidgetDetails = undefined;
        },
        invalidate:''}
    # Invalidation is a redraw/theme boundary, not widget disposal. Unmount
    # owns cleanup; disconnecting here loses future diagnostic repaints.
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "invalidate: () => {\n          renderInvalidator = void 0;\n          setRenderCallback(() => {\n          });\n        }"} \
      ${lib.escapeShellArg "invalidate: () => {}"}
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "fitCompactHeader(w, cyan(\"pi-lens\"), langStr ? dim(langStr) : \"\", lspChip, summary)"} \
      ${lib.escapeShellArg "fitCompactHeader(w, cyan(\"◇ lens\"), \"\", lspChip, summary)"}
  '';

  lazyCoreTools = lib.concatMapStrings (name: ''
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "        piName: \"${name}\","} \
      ${lib.escapeShellArg "        piName: \"${name}\",\n        situational: true,"}
  '') core;
}
