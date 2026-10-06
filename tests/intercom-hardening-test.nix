# Asserts the two intercom security defaults are present in what we actually
# install. pi-custom's own tests cover the broker's behaviour; this catches
# somebody flipping the messaging option's default, or the refusal going
# missing from the packaged broker, while the build stays green.
{
  pkgs,
  self,
  ...
}:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  ext-pi-custom = self.packages.${system}.ext-pi-custom;

  agent = self.lib.mkCodingAgent {
    inherit pkgs;
    modules = [
      {
        pi.coding-agent = {
          custom.enable = true;
          messaging.enable = true;
        };
      }
    ];
  };

  # Asserted at eval time rather than in shell: the value is a Nix attrset, and
  # a JSON round-trip through grep would pass on a substring match.
  trigger = agent.config.pi.coding-agent.finalConfigFiles."intercom/config.json".inboundTrigger;
in
if trigger != "replies" then
  throw "intercom hardening: inboundTrigger defaults to \"${trigger}\", must be \"replies\" (addendum §17.9 Risk 1)"
else
  pkgs.runCommand "pi-nix-intercom-hardening" { } ''
    broker=${ext-pi-custom}/src/intercom/broker/broker.ts
    fail() { echo "HARDENING REGRESSION: $1"; exit 1; }

    test -f "$broker" || fail "$broker is not in the package"
    grep -qF 'Session ID already held by a live session' "$broker" \
      || fail "the live session-ID collision is not refused (addendum §17.9 Risk 2)"

    echo "intercom hardening: live session-ID collision refused, inboundTrigger=replies"
    touch $out
  ''
