{ lib }:
# pi-usage shows what it knows only as setStatus text: "chatgpt plan 56% ↻
# 3d5h · app ↻ 5d15h". A footer that wants to draw plan usage as its own
# widgets would have to scrape that line. This publishes the report itself on
# pi's event bus, "pi-usage:report" with { report }, whenever the status is
# published, and { report: undefined } when it is cleared. agent-statusline's
# pi extension consumes it.
#
# --replace-fail, so an upstream rewrite of either function breaks the build
# instead of silently dropping the event.
let
  # Indented to sit inside the functions it lands in.
  emit =
    report:
    lib.concatMapStrings (line: "    ${line}\n") [
      "try {"
      "  pi.events.emit(\"pi-usage:report\", { report: ${report} });"
      "} catch {"
      "  // A footer that fails on the report must not stop the usage status."
      "}"
    ];
in
{
  reportEvent = ''
    substituteInPlace src/usage.ts --replace-fail \
      ${lib.escapeShellArg "  const publishStatus = (ctx: ExtensionContext, outcome: QueryOutcome, model: PiModel, shouldSchedule: boolean) => {\n    clearStatusCountdownTimer();\n"} \
      ${lib.escapeShellArg "  const publishStatus = (ctx: ExtensionContext, outcome: QueryOutcome, model: PiModel, shouldSchedule: boolean) => {\n    clearStatusCountdownTimer();\n${emit ''outcome.state.status === "ready" ? outcome.state.report : undefined''}"}
    substituteInPlace src/usage.ts --replace-fail \
      ${lib.escapeShellArg "    clearStatusTimers();\n    safeSetStatus(ctx, undefined);\n  };\n"} \
      ${lib.escapeShellArg "    clearStatusTimers();\n    safeSetStatus(ctx, undefined);\n${emit "undefined"}  };\n"}
  '';
}
