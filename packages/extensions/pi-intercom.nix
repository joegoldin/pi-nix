# pi-intercom 0.10.1: pi's missing ListAgents/SendMessage, over a local Unix
# domain socket at $PI_CODING_AGENT_DIR/intercom/broker.sock.
#
# Zero runtime dependencies. The package declares tsx, but tsx is only reached
# on upstream's default launch path, and we do not take it: the module points
# brokerCommand at a bun store path, and `bun broker/broker.ts` runs the broker
# with no node_modules at all. That also avoids a real bug. Upstream's default
# path calls getNodeCommand(process.execPath), which falls back to the literal
# string "node" resolved through PATH whenever the interpreter is not Node, and
# under a Bun-built pi it never is.
#
# One patch, --replace-fail so an upstream change breaks the build rather than
# silently reverting a security default. See pi-intercom-patches.nix.
{
  lib,
  mkPiExtension,
  pin,
  securityPatch,
}:
mkPiExtension {
  pname = "pi-intercom";
  inherit (pin)
    version
    url
    hash
    bundled
    entrypoints
    skills
    prompts
    ;

  patchPhaseExtra = securityPatch;

  # NOT settings.json. pi-intercom reads
  # $PI_CODING_AGENT_DIR/intercom/config.json and never pi's settings. These are
  # the package's own defaults with the security-relevant ones corrected; the
  # `messaging` option overrides brokerCommand, inboundTrigger and confirmSend
  # on top.
  #
  # stableId is deliberately absent. index.ts resolves the session ID as
  # PI_INTERCOM_STABLE_ID ?? config.stableId ?? piSessionId, so one value in a
  # shared config.json would give every session on this machine the same ID and
  # each new session would evict the last.
  configFiles."intercom/config.json" = {
    brokerArgs = [ ];
    enabled = true;
    # Security default, addendum §17.9 Risk 1. Upstream ships "always", under
    # which any process that can open the socket starts a model turn in any
    # session with text that arrives as a *user* message. "replies" lets only a
    # reply to an ask this session originated auto-start a turn; unsolicited
    # sends are still delivered and rendered, they just do not drive the agent.
    inboundTrigger = "replies";
    confirmSend = false;
    replyHint = true;
  };

  # Trust policy for peer-authored text. registerTool's promptSnippet covers how
  # to call the tool; it cannot express what authority the *received* text
  # carries, which is why this uses design §8's escape hatch. Task 8 owns it.
  promptFragment = builtins.readFile ../../prompt/untrusted-peer-input.md;

  meta = {
    description = "Direct 1:1 messaging between pi sessions on the same machine";
    homepage = "https://github.com/nicobailon/pi-intercom";
    license = lib.licenses.mit;
  };
}
