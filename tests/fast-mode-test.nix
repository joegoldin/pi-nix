{ pkgs, self, ... }:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  pi = self.packages.${system}.coding-agent-bun;
  fast = self.packages.${system}.ext-pi-fast;
in
pkgs.runCommand "pi-fast-mode-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  export HOME="$TMPDIR"
  bun ${./fast-mode.mjs} ${builtins.head fast.passthru.piEntrypoint} ${pi}/lib/node_modules
  touch $out
''
