# Proves the checks plumbing works end to end before any real test depends on
# it. If this ever fails, the harness is broken, not the code under test.
{ pkgs, ... }:
pkgs.runCommand "pi-nix-smoke-test" { } ''
  set -euo pipefail
  test "$(echo pi-nix)" = "pi-nix"
  touch $out
''
