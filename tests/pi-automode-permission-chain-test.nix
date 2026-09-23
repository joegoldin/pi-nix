{ pkgs, self, ... }:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  packages = self.packages.${system};
in
pkgs.runCommand "pi-automode-permission-chain-test"
  {
    nativeBuildInputs = [ pkgs.bun ];
  }
  ''
    cp -R ${packages.ext-czottmann-pi-automode} automode
    chmod -R u+w automode
    # Pi's loader supplies these peers; plain Bun needs explicit resolution.
    ln -s ${packages.coding-agent}/lib/node_modules/@earendil-works automode/node_modules/@earendil-works
    export AUTOMODE_PACKAGE="$PWD/automode"
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
