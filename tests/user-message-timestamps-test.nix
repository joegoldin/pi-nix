{ pkgs, self, ... }:
let
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.coding-agent-bun;
in
pkgs.runCommand "pi-user-message-timestamps-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  export HOME="$TMPDIR"
  bun ${./user-message-timestamps.mjs} ${pi}/lib/node_modules
  touch $out
''
