{ pkgs, self, ... }:
let
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
in
pkgs.runCommand "pi-nix-web-access-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  bun ${./web-access-smoke.mjs} \
    ${packages.ext-pi-web-access} \
    ${packages.coding-agent-bun}/lib/node_modules
  touch $out
''
