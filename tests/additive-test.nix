# The fork's central promise is that upstream rebases stay clean. That promise
# is only worth something if it is a test. This one is a content check rather
# than a git check, so it works inside the Nix sandbox: each protected file's
# hash is recorded here, and any edit to one breaks the build with the file
# name in the message.
#
# When a reviewed upstream rebase or Pi runtime upgrade changes these files,
# update its hash here in the same commit as the rebase. That is the point:
# the hash changing should be a deliberate act, never a side effect.
{ pkgs, ... }:
let
  protected = {
    "coding-agent/options.nix" = ../coding-agent/options.nix;
    "coding-agent/package.nix" = ../coding-agent/package.nix;
    "coding-agent/package-bun.nix" = ../coding-agent/package-bun.nix;
    "coding-agent/bun.nix" = ../coding-agent/bun.nix;
    "sync.nix" = ../sync.nix;
    "regenerate-models.nix" = ../regenerate-models.nix;
    "scan.nix" = ../scan.nix;
    "VERSION.json" = ../VERSION.json;
  };

  actual = pkgs.lib.mapAttrs (_name: path: builtins.hashFile "sha256" path) protected;

  # Recorded for Pi 1.4.0, on the upstream/master @ b4773a5 base, plus fork edits
  # to the protected files. Earlier baselines included edits to four
  # of them. Each is a deliberate divergence with its reason written where it
  # lives:
  #
  #   bun.nix, package-bun.nix, sync.nix -- copyPathToStore on a
  #   workspace member reads the path at evaluation time, which is
  #   import-from-derivation and serialised every build behind a single-threaded
  #   eval. Replaced by a runCommand factory. sync.nix's rewrite seds keep
  #   `just update-pi` from reintroducing it.
  #
  #   options.nix -- jail.privateAgentSubdirs has to append its tmpfs after the
  #   agent-directory bind, and that bind is emitted here.
  #   VERSION.json, bun.nix -- the Pi 1.5.2 source and generated dependencies;
  #   bun.nix also maps apps/* workspace members through workspaceSubdir.
  #   package.nix, package-bun.nix -- upstream's pi-patch hook, as upstream.
  #   regenerate-models.nix -- upstream's version, applying pi-patch before npm ci.
  #   options.nix -- retain the published launcher configuration/MCP merge wiring.
  #   runtime-check.mjs checks model-selection and package-filter glob
  #   compatibility against the minimatch that Pi ships.
  #   scan.nix -- supply zizmor's missing system AWS-LC build dependency.
  expected = {
    "VERSION.json" = "94cb5a64fd81d70defada1659f8b5fa1ce356ec15a2c277c88ecee793de3b06d";
    "coding-agent/bun.nix" = "cf20cb1e8ff0a4e454fd82664819a4fe5484c1635f5aad5f4cbd35fa96a03d30";
    "coding-agent/options.nix" = "8e4d15055baf64dd62f7e5d724d1fd958eee1cbec2299f5a414a8d8fb001747a";
    "coding-agent/package-bun.nix" = "658c5e5448f36273ac49e4eba53b6269c59f4b972a24075a01e3fafc4f13c571";
    "coding-agent/package.nix" = "87e9dd8852a559c1030cf4fb749e88369741b4461ec93a84aadc650a1bff4fac";
    "regenerate-models.nix" = "4bb61cde3414475d52c29a34b21a2a8ae5f1eaabc97f0fafc4d98c460f8b5b99";
    "scan.nix" = "f38a44631dd39dc4d4e2759760fa45909b5c50264b6b27b055d67d37a682d446";
    "sync.nix" = "08cb9c7c617181d00169c2dd9a510b9077989548e9a0d9270761ba873b3c7056";
  };

  drifted = pkgs.lib.attrNames (
    pkgs.lib.filterAttrs (name: h: (expected.${name} or null) != h) actual
  );
in
pkgs.runCommand "pi-nix-additive-test"
  {
    drifted = pkgs.lib.concatStringsSep " " drifted;
    recorded = builtins.toJSON actual;
  }
  ''
    set -euo pipefail
    if [ -n "$drifted" ]; then
      echo "Upstream files outside the permitted edit set changed: $drifted"
      echo ""
      echo "See docs/REBASING.md. If this is a deliberate upstream rebase, paste"
      echo "these hashes into the expected binding in tests/additive-test.nix,"
      echo "in the same commit as the rebase:"
      echo "$recorded"
      exit 1
    fi
    touch $out
  ''
