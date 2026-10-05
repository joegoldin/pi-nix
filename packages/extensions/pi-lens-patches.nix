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
  lazyCoreTools = lib.concatMapStrings (name: ''
    substituteInPlace dist/index.js --replace-fail \
      ${lib.escapeShellArg "        piName: \"${name}\","} \
      ${lib.escapeShellArg "        piName: \"${name}\",\n        situational: true,"}
  '') core;
}
