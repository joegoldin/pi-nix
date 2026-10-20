{ pkgs, self, ... }:
let
  lens = self.packages.${pkgs.stdenv.hostPlatform.system}.ext-pi-lens;
in
pkgs.runCommand "pi-lens-grammars-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  export HOME="$TMPDIR"
  bun ${./pi-lens-grammars.mjs} ${lens}
  touch $out
''
