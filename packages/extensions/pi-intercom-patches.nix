# Patches applied to pi-intercom's shipped TypeScript. --replace-fail, so an
# upstream edit that moves the target breaks the build instead of silently
# reverting a security default.
{ lib }:
let
  # Both blocks are built line by line rather than written as an indented Nix
  # string. `''` strips the common indentation, and these patterns live ten
  # spaces deep inside broker.ts, so a literal block would match nothing and
  # --replace-fail would fail the build for the wrong reason.
  lines = lib.concatStringsSep "\n";

  original = lines [
    "        if (previous) {"
    "          this.clearMessageReceiptRoutesForSession(id);"
    "          previous.socket.end();"
    "        }"
  ];

  refuse = lines [
    "        if (previous) {"
    "          writeMessage(socket, {"
    "            type: \"error\","
    "            error: \"Session ID already held by a live session\","
    "          });"
    "          socket.destroy();"
    "          break;"
    "        }"
  ];
in
{
  # Addendum §17.9 Risk 2. register lets a client choose its own sessionId, and
  # when a live session already holds that ID the broker ends the incumbent's
  # socket and hands the ID over. No flag is required, and the ID is not a
  # secret: any registered peer may `list`, and `list` returns every session's
  # UUID. Since the broker is the authority on which socket owns an ID, the
  # attacker inherits the victim's identity for every subsequent send.
  #
  # Refusing a LIVE collision is the minimal fix. Reconnect-after-disconnect is
  # untouched: a closed session moves to `disconnectedSessions` and is no longer
  # matched by `this.sessions.get(id)`, so restart-stable addressing via
  # stableId keeps working.
  securityPatch = ''
    substituteInPlace broker/broker.ts --replace-fail ${lib.escapeShellArg original} ${lib.escapeShellArg refuse}
  '';
}
