{ pkgs, self, ... }:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  packages = self.packages.${system};
in
pkgs.runCommand "pi-automode-permission-chain-test"
  {
    nativeBuildInputs = [ pkgs.bun ];
    AUTOMODE_PACKAGE = packages.ext-czottmann-pi-automode;
  }
  ''
    cp -R ${packages.ext-gotgenes-pi-permission-system} permissions
    chmod -R u+w permissions
    # Bun needs the suffix that Pi's TypeScript loader resolves implicitly.
    substituteInPlace permissions/package.json \
      --replace-fail '"#src/*": "./src/*"' '"#src/*": "./src/*.ts"'
    export PERMISSION_PACKAGE="$PWD/permissions"
    cp ${./pi-automode-permission-chain.test.ts} permission-chain.test.ts
    bun test permission-chain.test.ts
    touch $out
  ''
