{ pkgs, self, ... }:
let
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
  pi = packages.coding-agent-bun;
in
pkgs.runCommand "pi-subagent-host-peers-tests"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.patch
    ];
  }
  ''
    export HOME="$TMPDIR"
    node ${./subagent-host-peers.mjs} ${pi}/lib/node_modules ${packages.ext-pi-subagents}

    # The next sync must retain the worker dependencies, not just today's lock.
    cp -R ${pi.workspacePackages.src} source
    chmod -R u+w source
    cp ${../package-lock.json} source/package-lock.json
    cd source
    # The workspace source already carries dependency-updates.patch.
    patch --batch --forward --fuzz=0 -p1 < ${../coding-agent/installer-chord.patch}
    node scripts/generate-coding-agent-install-lock.mjs
    cmp packages/coding-agent/install-lock/package.json ${../coding-agent/install-lock/package.json}
    cmp packages/coding-agent/install-lock/package-lock.json ${../coding-agent/install-lock/package-lock.json}
    touch $out
  ''
