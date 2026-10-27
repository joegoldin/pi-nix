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
  #   VERSION.json, bun.nix -- the Pi 1.4 source and generated dependencies.
  #   package.nix, package-bun.nix, sync.nix -- apply the audited dependency
  #   compatibility hook consistently to npm and Bun builds and regeneration.
  #   regenerate-models.nix -- apply the same manifest patches before npm ci.
  #   options.nix -- retain the published launcher configuration/MCP merge wiring.
  expected = {
    "VERSION.json" = "dd8e48737748a3613acb76c041a7a962da55f702bd1cd22fa5e56f12ecf77ce9";
    "coding-agent/bun.nix" = "71950b35ce99c3c1132daf9f3c5e81f4a82cc018fd0eb0da4d66ad88969082b0";
    "coding-agent/options.nix" = "8e4d15055baf64dd62f7e5d724d1fd958eee1cbec2299f5a414a8d8fb001747a";
    "coding-agent/package-bun.nix" = "d3439e7199c9b4ee7d6e610dc5311bf361e9d766a298905cc2424db57187bdbc";
    "coding-agent/package.nix" = "2365edc0215c9ee48f34e45c1b143999daeef7011db7637de181fd0240f2dd67";
    "regenerate-models.nix" = "c91f62b9768a2af5129b8a02c55b887c4edf3a47aa7021ef79c184d9b8c116b4";
    "scan.nix" = "916d7beef7edc2b9c586b5e2050f826d311af9e95a3d31b315be1648b8a2da14";
    "sync.nix" = "395a4441c88c3717baaa4f7855f5f634c3273b04470794a95fdce58bb0adf2f1";
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
