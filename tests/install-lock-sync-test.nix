{ pkgs, self, ... }:
let
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.coding-agent-bun;
in
pkgs.runCommand "pi-install-lock-sync-tests"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.patch
    ];
  }
  ''
    export HOME="$TMPDIR"

    # Keep the generator check even though the subagent worker check is gone.
    cp -R ${pi.workspacePackages.src} source
    chmod -R u+w source
    cp ${../package-lock.json} source/package-lock.json
    cd source
    patch --batch --forward --fuzz=0 -p1 < ${../coding-agent/installer-chord.patch}
    node scripts/generate-coding-agent-install-lock.mjs
    cmp packages/coding-agent/install-lock/package.json ${../coding-agent/install-lock/package.json}
    cmp packages/coding-agent/install-lock/package-lock.json ${../coding-agent/install-lock/package-lock.json}
    touch $out
  ''
