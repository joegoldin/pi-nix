# @czottmann/pi-automode, built from joegoldin/pi-automode rather than from npm.
#
# The fork carries two commits on top of upstream's v1.11.0. The first: auto
# mode registers itself on `@gotgenes/pi-permission-system`'s authorizer chain,
# so the two packages compose instead of contending for pi's `tool_call` event.
# `docs/assumption-a2.md` has the whole argument; the short version is that pi's
# `emitToolCall` returns on the first extension that blocks, so two gates on one
# event means the first one loaded answers every ask and the second is dead
# code. The permission system publishes a seam for exactly this — a typed
# service on `Symbol.for("@gotgenes/pi-permission-system:service")` with
# `registerAuthorizer` — and upstream does not use it.
#
# The second: `PI_AUTOMODE_NO_STATUS_SLOT` makes auto mode stop drawing its own
# status slot and republish the same tally on a `pi-automode:status` channel,
# for a host that already renders a status line and wants the tally on a row of
# its own rather than twice.
#
# Kept additive, so upstream replays underneath: one new module plus six lines
# in the entrypoint, and `extensions/auto-mode/extension.ts` byte-identical.
# The fork's own `docs/REBASING.md` names what an upstream change would cost.
#
# Fetched from the tag rather than the npm registry, which is why this file
# exists instead of a line in `extensions.json`: nothing publishes this build,
# so there is no `dist.tarball` to pin. `fetchFromGitHub` hashes the unpacked
# tree, so a regenerated GitHub tarball cannot break the pin the way a
# `fetchurl` on `codeload` would.
#
# The npm pin stays in `extensions.json` as the upstream provenance record and
# as what `nix run .#update-extensions` tracks. When upstream releases, that
# pin moves first and the fork is rebased onto the new tag second; this file's
# `upstreamVersion` is the assertion that the two are talking about the same
# release.
{
  lib,
  fetchFromGitHub,
  mkPiExtension,
  pin,
}:
let
  upstreamVersion = "1.11.0";
  forkVersion = "${upstreamVersion}-jg.3";
in
assert lib.assertMsg (pin.version == upstreamVersion) ''
  packages/extensions/czottmann-pi-automode.nix is built from the fork at
  v${forkVersion}, which carries upstream ${upstreamVersion}, but
  extensions.json now pins ${pin.version}.

  Rebase joegoldin/pi-automode onto upstream's v${pin.version}, tag it, and
  update `upstreamVersion`, `forkVersion`, `rev` and `hash` here together.
'';
mkPiExtension {
  pname = "@czottmann/pi-automode";
  version = forkVersion;

  # The local-src arm: no tarball, no bun, and no node_modules, because the
  # package's only dependencies are the `@earendil-works/*` peers pi supplies
  # itself. It also drops `*.test.ts` and `tsconfig.json`, which the git tree
  # carries and the npm tarball does not.
  src = fetchFromGitHub {
    owner = "joegoldin";
    repo = "pi-automode";
    rev = "v${forkVersion}";
    hash = "sha256-II0wBRErESOJRnLiyaV0Nw5th3Ox9buiTMGii6TFhyE=";
  };

  inherit (pin) entrypoints skills prompts;

  meta = {
    description = "Claude Code-style auto mode guardrail for pi, with a pi-permission-system chain link";
    homepage = "https://github.com/joegoldin/pi-automode";
    license = lib.licenses.mit;
  };
}
