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

  # Recorded from upstream/master @ 273a552, plus the fork's own edits to four
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
    "VERSION.json" = "267495f03e5b7812fe05260a1dd4bd3499b5fac84324aeaae12e6521c8524bd8";
    "coding-agent/bun.nix" = "a73880ce08e0aceff1eb52f43b1235965c5b0ce8527d7d37cbea9b80ad104d2c";
    "coding-agent/options.nix" = "77c4c54abf1ec656b266ae8337e5af5ce035a0835a2dc26e549d580890b27dd6";
    "coding-agent/package-bun.nix" = "a43765637bb0cf75b707e04cec48ea146952a0898aecd9a1df65a9c6cfe658c2";
    "coding-agent/package.nix" = "cf03c7b7cf2bbfe7c12a843106fbeb3a35e654b9198ce1130632f060f9315147";
    "regenerate-models.nix" = "07bfbabf29eff626a34056ac21301b726ac746771d921700b391887f4847f8ab";
    "scan.nix" = "7c445159b27fbaf0ea5d0ee48217944336f38167be317775129c24c7c3493794";
    "sync-upstream.nix" = "0ace4193ca8cee224212724519dbf8c3562a19e99c6959623ff88a762ccf9e56";
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
