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
  # line above the footer. Draw nothing until there is something to say.
  quietEmptyWidget = ''
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "  lines.push(fitLine(header, w));\n  if (totalSuppressed > 0) {"} \
      ${lib.escapeShellArg "  if (!langStr && !lspChip && !summary && totalSuppressed === 0 && recencySorted.length === 0)\n    return [];\n  lines.push(fitLine(header, w));\n  if (totalSuppressed > 0) {"}
  '';

  lazyCoreTools = lib.concatMapStrings (name: ''
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "        piName: \"${name}\","} \
      ${lib.escapeShellArg "        piName: \"${name}\",\n        situational: true,"}
  '') core;
}
