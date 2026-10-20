{ pkgs, self, ... }:
let
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.coding-agent-bun;
in
pkgs.runCommand "pi-queued-messages-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  export HOME="$TMPDIR"
  bun ${./queued-messages.mjs} ${pi}/lib/node_modules
  touch $out
''
