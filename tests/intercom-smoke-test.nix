# The whole pi↔pi channel, end to end, on the exact pi-custom tree we install,
# with the broker launched the way the messaging option has pi-custom launch it.
# Depends on neither pi nor node_modules: spawn.ts and broker.ts import only
# node builtins and relative .ts files, so bun runs them straight out of the
# store.
{
  pkgs,
  self,
  ...
}:
let
  inherit (pkgs) lib;
  inherit (pkgs.stdenv.hostPlatform) system;
  ext-pi-custom = self.packages.${system}.ext-pi-custom;
in
pkgs.runCommand "pi-nix-intercom-smoke"
  {
    nativeBuildInputs = [ pkgs.bun ];
  }
  ''
    export HOME=$TMPDIR/home
    mkdir -p "$HOME"

    bun ${./intercom/intercom-smoke.mjs} ${ext-pi-custom} ${lib.getExe pkgs.bun}

    touch $out
  ''
