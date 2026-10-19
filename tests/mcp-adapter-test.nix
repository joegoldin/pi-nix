# Load the packaged adapter in Pi and call local fixtures directly and through
# codemode. This exercises both config formats without a provider or credentials.
{ pkgs, self, ... }:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  packages = self.packages.${system};
in
pkgs.runCommand "pi-nix-mcp-adapter-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  bun ${./mcp-adapter-smoke.mjs} \
    ${packages.ext-pi-mcp-adapter} \
    ${packages.coding-agent-bun}/lib/node_modules
  touch $out
''
