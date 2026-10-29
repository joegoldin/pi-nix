{ pkgs, self, ... }:
let
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.coding-agent-bun;
in
pkgs.runCommand "pi-program-status-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  export HOME="$TMPDIR"
  bun ${./program-status.mjs} ${pi}/lib/node_modules
  touch $out
''
