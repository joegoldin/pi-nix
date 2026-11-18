{ pkgs, self, ... }:
let
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.coding-agent-bun;
in
pkgs.runCommand "pi-open-browser-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  export HOME="$TMPDIR"
  bun ${./open-browser.mjs} ${pi}/lib/node_modules/@earendil-works ${pkgs.bash}/bin/bash
  touch $out
''
