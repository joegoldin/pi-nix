# Patches applied to pi-cache-optimizer's shipped TypeScript. --replace-fail,
# so an upstream edit that moves the target breaks the build instead of
# silently restoring a second status line.
{ lib }:
let
  # Built line by line rather than as an indented Nix string: `''` strips the
  # common indentation and these statements live four spaces deep inside
  # index.ts, so a literal block would match nothing and --replace-fail would
  # fail the build for the wrong reason.
  lines = lib.concatStringsSep "\n";

  original = lines [
    "    lastStatusText = statusText;"
    "    ctx.ui.setStatus(STATUS_KEY, statusText);"
  ];

  guarded = lines [
    "    lastStatusText = statusText;"
    "    // Patched by pi-nix: see pi-cache-optimizer-patches.nix."
    "    if (process.env.PI_CACHE_OPTIMIZER_NO_STATUS_SLOT !== \"1\") {"
    "      ctx.ui.setStatus(STATUS_KEY, statusText);"
    "    }"
  ];
in
{
  # The extension draws `OpenAI cache 77/79·5.40M/5.75M 93.9%` into a status
  # slot of its own, unconditionally: there is no setting, no config file key,
  # and no environment variable for it upstream.
  #
  # On a host that already renders a status line with a cache widget, that is
  # the same numbers twice, one line apart, in two different formats. The
  # widget is the better of the two -- it reads the same sidecar
  # ($PI_CODING_AGENT_DIR/pi-cache-optimizer-stats.json), and it draws in the
  # host's palette with the host's bar -- so the slot is the copy to drop.
  #
  # Suppression only, with no republication, which is where this differs from
  # the auto-mode fork's equivalent: auto mode's tally lives in memory and has
  # to be handed over on a channel, while the cache figures are already on disk
  # for anyone to read.
  #
  # Guarded rather than deleted so the default is upstream's. Unset, this build
  # behaves exactly as the published one does.
  suppressibleStatusSlot = ''
    substituteInPlace index.ts --replace-fail ${lib.escapeShellArg original} ${lib.escapeShellArg guarded}
  '';
}
