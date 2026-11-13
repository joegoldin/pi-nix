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
  # line above the footer. Keep the compact control if an expanded view has
  # no detail rows, so clicking it never removes the way to collapse it.
  quietEmptyWidget = ''
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "  lines.push(fitLine(header, w));\n  if (totalSuppressed > 0) {"} \
      ${lib.escapeShellArg "  if (!langStr && !lspChip && !summary && totalSuppressed === 0 && recencySorted.length === 0)\n    return [fitCompactHeader(w, cyan(\"◇ lens\"), \"\", lspChip, summary)];\n  lines.push(fitLine(header, w));\n  if (totalSuppressed > 0) {"}
  '';

  # The dashboard consumes the compact chip when available; the native widget
  # then owns only expanded detail rows. Both surfaces share one click state.
  compactToggleWidget = ''
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "      const compactWidget = getLensFlag(\"lens-compact-widget\") === true;"} \
      ${lib.escapeShellArg ''
        let compactWidget = true;
        const inlineKey = Symbol.for("pi.inline-status-widgets.v1");
        const inline = globalThis[inlineKey] ??= { widgets: new Map(), consumers: new Set() };
        const toggle = (event) => {
          if (event.type !== "click" || event.button !== "left") return;
          compactWidget = !compactWidget;
          tui.requestRender();
          return { handled: true, render: true };
        };
        const chip = {
          render: (width, chipTheme) => renderWidget(width, chipTheme, { compact: true })[0] ?? "",
          handleMouse: toggle,
        };
        inline.widgets.set("pi-lens", chip);
      ''}
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "          return renderWidget(width, theme, { compact: compactWidget });\n        },\n        invalidate:"} \
      ${lib.escapeShellArg ''
          const embedded = inline.consumers.size > 0;
          const compact = !ui.getToolsExpanded?.() && compactWidget;
          if (embedded && compact) return [];
          const rows = renderWidget(width, theme, { compact });
          return embedded && rows.length === 1 && rows[0] === chip.render(width, theme) ? [] : rows;
        },
        handleMouse: toggle,
        dispose: () => {
          if (inline.widgets.get("pi-lens") === chip) inline.widgets.delete("pi-lens");
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
