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

  # Recorded from upstream/master @ 273a552.
  expected = {
    "VERSION.json" = "267495f03e5b7812fe05260a1dd4bd3499b5fac84324aeaae12e6521c8524bd8";
    "coding-agent/bun.nix" = "d9685377a8e6ca36ecf183171a16f3c91d51be0624bf7b3b4b9c625ea1d47fd1";
    "coding-agent/options.nix" = "bd0afe75705f9f7d3443cb943509515a4071ee08d11aaf07dc0a4e5c00e857a6";
    "coding-agent/package-bun.nix" = "82665afa5e7370bd3990d31483a845e0906a8b16b4a7e0a98d72390d349570b2";
    "coding-agent/package.nix" = "cf03c7b7cf2bbfe7c12a843106fbeb3a35e654b9198ce1130632f060f9315147";
    "regenerate-models.nix" = "07bfbabf29eff626a34056ac21301b726ac746771d921700b391887f4847f8ab";
    "scan.nix" = "7c445159b27fbaf0ea5d0ee48217944336f38167be317775129c24c7c3493794";
    "sync-upstream.nix" = "6b059fbf7e9d22b21357ab5973f679a4643a104e0145bb348ec32b3659bb78e2";
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
