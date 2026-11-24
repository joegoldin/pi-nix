{ pkgs, self, ... }:
let
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.coding-agent-bun;
in
pkgs.runCommand "pi-relative-markdown-links-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  bun ${./relative-markdown-links.mjs} ${pi}/lib/node_modules
  touch "$out"
''
