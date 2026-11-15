{ pkgs, self, ... }:
let
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.coding-agent-bun;
in
pkgs.runCommand "pi-selection-copy-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  bun ${./selection-copy.mjs} ${pi}/lib/node_modules/@earendil-works/pi-tui/dist
  touch $out
''
