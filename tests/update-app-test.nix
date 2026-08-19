# The updater is network-bound, so the check is a contract test rather than a
# run: it proves the app exists, is shellcheck-clean (writeShellApplication
# enforces that at build time), preserves the two fields that are human
# decisions rather than registry facts, and carries the normalisation and
# platform flags whose absence produces failures that only appear later.
{ pkgs, ... }:
let
  updateExtensions = import ../update-extensions.nix { inherit pkgs; };
in
pkgs.runCommand "pi-nix-update-app-tests" { } ''
  set -euo pipefail
  script=${updateExtensions}/bin/pi-update-extensions
  test -x "$script"

  # `bundled` and `entrypoints` are overrides a human sets after inspecting a
  # package; a registry bump must never clobber them.
  ! grep -q '\.bundled *=' "$script"
  ! grep -q '\.entrypoints *=' "$script"

  # No npm may reappear here by accident.
  ! grep -q 'npmDepsHash' "$script"
  ! grep -q 'prefetch-npm-deps' "$script"

  # The fields and mechanisms it must carry.
  grep -q 'dist.integrity' "$script"
  grep -q 'dist-tags' "$script"
  grep -q 'bun2nix' "$script"
  # Without --os/--cpu the generated bun.nix omits every non-host platform
  # variant and the Darwin build of ext-heyhuynhgiabuu-pi-pretty fails.
  grep -q -- "--os='\*'" "$script"
  grep -q -- "--cpu='\*'" "$script"
  # The normalisation must be the same string mkPiExtension applies, or
  # --frozen-lockfile rejects the lockfile this app just wrote.
  grep -q 'peerDependenciesMeta' "$script"
  grep -q 'del(.devDependencies' "$script"

  touch $out
''
