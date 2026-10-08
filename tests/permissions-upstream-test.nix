# The upstream test suites of the two permission engines vendored into
# pi-permissions: src/engine from @gotgenes/pi-permission-system and src/auto
# from @czottmann/pi-automode. The suites live under
# ./permissions-upstream as upstream ships them and run against the vendored
# source, each under the runner it was written for: vitest for the permission
# system, `node --test` through tsx for auto mode. Neither runs under bun test
# (module mocks, child processes), which is why they are not in pi-permissions'
# own check.
#
# Each suite expects its package's layout: the permission system's tests reach
# `src/` through the `#src` alias and read config/, docs/ and schemas/ beside
# it; auto mode's resolve `extensions/auto-mode.ts` from the working directory.
# Both layouts are rebuilt here around a copy of the vendored source. A copy,
# not a symlink into the store: modules resolve from their real path, and the
# copy's imports must find pi's packages in node_modules here.
{ pkgs, self, ... }:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  piModules = "${self.packages.${system}.coding-agent-bun}/lib/node_modules";
  piPermissions = self.packages.${system}.ext-pi-permissions;
in
pkgs.stdenv.mkDerivation {
  name = "pi-nix-permissions-upstream-tests";
  src = ./permissions-upstream;

  nativeBuildInputs = [
    pkgs.bun2nix.hook
    pkgs.bun
    pkgs.nodejs
  ];

  bunDeps = pkgs.bun2nix.fetchBunDeps { bunNix = import ./permissions-upstream/bun.nix; };
  # Copies, not links: node resolves a package's own imports from its real
  # path, and a package linked in from the store would look for its
  # dependencies there.
  bunInstallFlags = [
    "--linker=hoisted"
    "--frozen-lockfile"
    "--backend=copyfile"
  ];
  dontRunLifecycleScripts = true;

  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR"

    # pi's own packages, which pi supplies to extensions at runtime, then
    # pi-permissions' dependencies over them.
    for d in ${piModules}/*; do
      [ -e "node_modules/$(basename "$d")" ] || ln -s "$d" node_modules/
    done
    for d in ${piPermissions}/node_modules/*; do
      name=$(basename "$d")
      [ "$name" = .bin ] && continue
      rm -rf "node_modules/$name"
      ln -s "$d" "node_modules/$name"
    done

    cp -R ${piPermissions}/src vendored
    chmod -R u+w vendored
    ln -s ../vendored/engine engine/src
    # Two tests import pi's internals through the package's own node_modules.
    ln -s ../node_modules engine/node_modules
    mkdir -p auto/extensions
    ln -s ../../vendored/auto auto/extensions/auto-mode
    ln -s ../../vendored/auto/index.ts auto/extensions/auto-mode.ts

    (cd engine && node ../node_modules/vitest/vitest.mjs run)
    (cd auto && node --import tsx --test tests/*.test.ts)
    runHook postBuild
  '';

  installPhase = ''
    touch $out
  '';
}
