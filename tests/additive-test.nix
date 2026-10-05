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
    "sync.nix" = ../sync.nix;
    "regenerate-models.nix" = ../regenerate-models.nix;
    "scan.nix" = ../scan.nix;
    "VERSION.json" = ../VERSION.json;
  };

  actual = pkgs.lib.mapAttrs (_name: path: builtins.hashFile "sha256" path) protected;

  # Recorded from upstream/master @ b4773a5, plus the fork's own edits to four
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
  expected = {
    "VERSION.json" = "9edc0cc1c23cf92df06b75a7a80da22b5c92f42892829b824e5b53d770ee5841";
    "coding-agent/bun.nix" = "283e48b1c3106d6351bc4f75a5030cb536510af7b77a5ab2079891ff5027283c";
    "coding-agent/options.nix" = "9aa0f06210faddd4e4724f286c591bbffb0935f11a0d3bad4634d5b91d753b03";
    "coding-agent/package-bun.nix" = "2b3c3671c40e3e9b2ed0f8f233bf84c18e3002c3986ff9454bb4feaafb9f46e8";
    "coding-agent/package.nix" = "faf1fab660452e42cb2d9a528ccc273e88c4b6dd00996e7161493c080d433faa";
    "regenerate-models.nix" = "d9ade9a165e7de1a1cefc1ae859a1f30cff317e2076e3d9fbae07d4bd8cfbea5";
    "scan.nix" = "916d7beef7edc2b9c586b5e2050f826d311af9e95a3d31b315be1648b8a2da14";
    "sync.nix" = "7a0055e9684df1aa61d634ff8f8d360341da1c05537c350979a5dccfd5e4717d";
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
