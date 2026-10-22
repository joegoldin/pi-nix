{ pkgs, self, ... }:
let
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
in
pkgs.runCommand "pi-subagent-expanded-output-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  export HOME="$TMPDIR"
  export NODE_PATH=${packages.coding-agent-bun}/lib/node_modules
  bun ${./subagent-expanded-output.mjs} ${packages.ext-pi-subagents}
  touch $out
''
