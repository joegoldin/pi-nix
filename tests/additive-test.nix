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
    "VERSION.json" = "33a02c3e7b7de7e275abc467a39680377e4f3769215d6cc7b49ae49cc423953f";
    "coding-agent/bun.nix" = "6bbf114580069e9225fa8f28a6ba6e8492eb77d0e4700577970c20f3d60ba9f1";
    "coding-agent/options.nix" = "7ba20b8f4c6899e79850e2a44280409ec4c46bc07c95145d4f89c64222329f9d";
    "coding-agent/package-bun.nix" = "c264e410142b6aa0e9895606c582756ab1e449e6eaa5d862a3c602284175f147";
    "coding-agent/package.nix" = "ffc7bbef83095232209945d75d7a9421b08879cea5fc40c6bf81bab09e205773";
    "regenerate-models.nix" = "96b0eb5aa82e9d9a463574db3180aeed1328d709f0247620e30221f7499a4eff";
    "scan.nix" = "5fab541f642cdd7ef2887c58acfe826017bc035899f25540e1c01483e79d4080";
    "sync-upstream.nix" = "eabd44f588af4b8250f6017d80716a8950eb30351d1f0df5ab10b0e60c3e21fe";
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
