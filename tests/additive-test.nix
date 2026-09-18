# The fork's central promise is that upstream rebases stay clean. That promise
# is only worth something if it is a test. This one is a content check rather
# than a git check, so it works inside the Nix sandbox: each protected file's
# hash is recorded here, and any edit to one breaks the build with the file
# name in the message.
#
# When a legitimate `git rebase upstream/master` changes one of these files,
# update its hash here in the same commit as the rebase. That is the point:
# the hash changing should be a deliberate act, never a side effect.
{ pkgs, ... }:
let
  protected = {
    "coding-agent/options.nix" = ../coding-agent/options.nix;
    "coding-agent/package.nix" = ../coding-agent/package.nix;
    "coding-agent/package-bun.nix" = ../coding-agent/package-bun.nix;
    "coding-agent/bun.nix" = ../coding-agent/bun.nix;
    "sync-upstream.nix" = ../sync-upstream.nix;
    "regenerate-models.nix" = ../regenerate-models.nix;
    "scan.nix" = ../scan.nix;
    "VERSION.json" = ../VERSION.json;
  };

  actual = pkgs.lib.mapAttrs (_name: path: builtins.hashFile "sha256" path) protected;

  # Recorded from upstream/master @ b4773a5, plus the fork's own edits to four
  # of them. Each is a deliberate divergence with its reason written where it
  # lives:
  #
  #   bun.nix, package-bun.nix, sync-upstream.nix -- copyPathToStore on a
  #   workspace member reads the path at evaluation time, which is
  #   import-from-derivation and serialised every build behind a single-threaded
  #   eval. Replaced by a runCommand factory. sync-upstream's rewrite seds keep
  #   `just update-pi` from reintroducing it.
  #
  #   options.nix -- jail.privateAgentSubdirs has to append its tmpfs after the
  #   agent-directory bind, and that bind is emitted here.
  expected = {
    "VERSION.json" = "2d7ef0104774c1e031082a3d81500985516c0d249ae7863eaca0b98620b0148a";
    "coding-agent/bun.nix" = "0289c33689303c601bbc668ae56bdd84bfc3cd48ba0c1cfff94a563fc2f36f8a";
    "coding-agent/options.nix" = "7ba20b8f4c6899e79850e2a44280409ec4c46bc07c95145d4f89c64222329f9d";
    "coding-agent/package-bun.nix" = "ebbbb6c72766e0074fc8e36373e7922abffd5ec7b73d01ce600bbd64772ceee2";
    "coding-agent/package.nix" = "3d5b171a6046e3963566a59b5009ccb7da3aefd436e41f1b526f45fa856ebcdb";
    "regenerate-models.nix" = "e6d383f7b7d71510493a11743ef4e4fd3e20886b3ebbf6d6a2bb0e123bba0a2a";
    "scan.nix" = "7c445159b27fbaf0ea5d0ee48217944336f38167be317775129c24c7c3493794";
    "sync-upstream.nix" = "115e7dfa5fd7459d5f4393f3ddd177cb1f2bac4d535c802d76461aeac2b48b66";
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
