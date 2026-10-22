{ pkgs, self, ... }:
let
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.coding-agent-bun;
in
pkgs.runCommand "pi-extension-dialogs-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  export HOME="$TMPDIR"
  export NODE_PATH=${pi}/lib/node_modules
  bun ${./extension-dialogs.mjs} ${pi}/lib/node_modules ${../packages/extensions/pi-custom/src}/tools/ask.ts
  touch $out
''
