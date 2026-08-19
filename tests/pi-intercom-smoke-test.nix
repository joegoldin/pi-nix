# The whole local channel, end to end, on the exact tree we install, launched
# the way the module launches it. Depends on neither pi nor node_modules:
# broker.ts's transitive imports are node builtins plus relative .ts files, so
# bun runs it straight out of the store.
{
  pkgs,
  self,
  ...
}:
let
  inherit (pkgs) lib;
  inherit (pkgs.stdenv.hostPlatform) system;
  ext-pi-intercom = self.packages.${system}.ext-pi-intercom;
in
pkgs.runCommand "pi-nix-pi-intercom-smoke"
  {
    nativeBuildInputs = [ pkgs.bun ];
  }
  ''
    export HOME=$TMPDIR/home
    mkdir -p "$HOME"

    bun ${./pi-intercom/intercom-smoke.mjs} ${ext-pi-intercom} ${lib.getExe pkgs.bun}

    touch $out
  ''
