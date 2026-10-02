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
    "VERSION.json" = "76a53cc37800ccfee29a4827f38b2e04638f3493a57e174de403cce23b569e72";
    "coding-agent/bun.nix" = "7f463e3c8be2b6b4b3090527d1d75250c9d2baa611b7b0d9f40d6da45ed45a72";
    "coding-agent/options.nix" = "9aa0f06210faddd4e4724f286c591bbffb0935f11a0d3bad4634d5b91d753b03";
    "coding-agent/package-bun.nix" = "5ea57719bb85881001f97465aa161efdeba4c77dc63a50bc123c19aa72612dde";
    "coding-agent/package.nix" = "f572b98fcfcadf627f92700fa5a3989ae7f3935668ac8b68b7928b1b49c622a9";
    "regenerate-models.nix" = "d9ade9a165e7de1a1cefc1ae859a1f30cff317e2076e3d9fbae07d4bd8cfbea5";
    "scan.nix" = "5fab541f642cdd7ef2887c58acfe826017bc035899f25540e1c01483e79d4080";
    "sync.nix" = "aba26550a83ddf84a21936cc88f6fee1dc0ab794e90677df8ec73e053199d2d0";
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
