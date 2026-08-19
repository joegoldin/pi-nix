# Asserts the security patch is present in the tree we actually install, and
# that the original is gone. --replace-fail already catches upstream drift; this
# catches the other direction, somebody deleting the patch from
# pi-intercom-patches.nix and leaving the build green.
{
  pkgs,
  self,
  ...
}:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  ext-pi-intercom = self.packages.${system}.ext-pi-intercom;

  # Asserted at eval time rather than in shell: the value is a Nix attrset, and
  # a JSON round-trip through grep would pass on a substring match.
  trigger = ext-pi-intercom.passthru.configFiles."intercom/config.json".inboundTrigger;
in
if trigger != "replies" then
  throw "pi-intercom hardening: inboundTrigger is \"${trigger}\", must be \"replies\" (addendum §17.9 Risk 1)"
else
  pkgs.runCommand "pi-nix-pi-intercom-hardening" { } ''
    root=${ext-pi-intercom}
    fail() { echo "HARDENING REGRESSION: $1"; exit 1; }

    grep -qF 'Session ID already held by a live session' "$root/broker/broker.ts" \
      || fail "the live session-ID collision is not refused (addendum §17.9 Risk 2)"
    grep -qF 'previous.socket.end();' "$root/broker/broker.ts" \
      && fail "the incumbent-evicting register path survived the patch"

    echo "pi-intercom hardening: live session-ID collision refused, inboundTrigger=replies"
    touch $out
  ''
