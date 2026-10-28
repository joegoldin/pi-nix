# Test derivations for the first-party extensions.
# Each runs twice over the same tree:
#
#   bun test — the unit suite against the packaged runtime, without network.
#
#   tsc --strict — the entrypoint against the packaged pi's .d.ts. That is what
#     pins ctx.modelRegistry.complete, ctx.signal, pi.events.emit and
#     ToolCallEventResult to the shapes pi really has rather than to the shapes
#     this fork believes it has. A pi bump that changes one fails here.
#
# PI_CODING_AGENT_SRC points at the same fetchFromGitHub output flake.nix
# builds pi from, so a test that wants to read pi's real source can. It is
# fetched here rather than read off packages.coding-agent.src, which since
# upstream split runtime dependencies out is an install lock, not the source.
{
  pkgs,
  self,
  ...
}:
let
  inherit (pkgs) lib;
  inherit (pkgs.stdenv.hostPlatform) system;

  piSrc =
    let
      pin = lib.importJSON ../VERSION.json;
    in
    pkgs.fetchFromGitHub {
      owner = "earendil-works";
      repo = "pi";
      inherit (pin) rev hash;
    };

  piModules = "${self.packages.${system}.coding-agent-bun}/lib/node_modules";

  tsconfig = pkgs.writeText "pi-extension-tsconfig.json" (
    builtins.toJSON {
      compilerOptions = {
        strict = true;
        noEmit = true;
        module = "esnext";
        moduleResolution = "bundler";
        target = "esnext";
        lib = [
          "esnext"
          "dom"
        ];
        allowImportingTsExtensions = true;
        skipLibCheck = true;
        types = [ "node" ];
      };
      include = [ "src/**/*.ts" ];
      exclude = [ "src/**/*.test.ts" ];
    }
  );

  mkTest =
    name: src:
    pkgs.runCommand "pi-nix-${name}-tests"
      {
        inherit src;
        nativeBuildInputs = [
          pkgs.bun
          pkgs.typescript
        ];
        PI_CODING_AGENT_SRC = piSrc;
      }
      ''
        set -euo pipefail
        cp -R "$src" work
        chmod -R u+w work
        cd work

        export HOME="$TMPDIR"

        mkdir node_modules
        for d in ${piModules}/*; do ln -s "$d" node_modules/; done
        bun test

        cp ${tsconfig} tsconfig.json
        tsc -p tsconfig.json

        touch $out
      '';

  # pi-custom calls into pi at runtime (its helpers, editor, components and
  # model registry). It also needs its own FFF dependency alongside the
  # packaged Pi runtime used by every extension check.
  # Its contract tests read pi's source, as the other first-party ones do.
  piCustomTsconfig = pkgs.writeText "pi-custom-tsconfig.json" (
    builtins.toJSON {
      compilerOptions = {
        strict = true;
        noEmit = true;
        module = "esnext";
        moduleResolution = "bundler";
        target = "esnext";
        lib = [ "esnext" ];
        allowImportingTsExtensions = true;
        skipLibCheck = true;
        types = [ "node" ];
      };
      include = [ "src/**/*.ts" ];
      exclude = [ "src/**/*.test.ts" ];
    }
  );

  piCustomTest =
    let
      piModules = "${self.packages.${system}.coding-agent-bun}/lib/node_modules";
      piCustom = self.packages.${system}.ext-pi-custom;
    in
    pkgs.runCommand "pi-nix-pi-custom-tests"
      {
        src = ../packages/extensions/pi-custom;
        PI_VOICE_SRC = ../packages/extensions/pi-voice;
        PI_PERMISSIONS_ENTRY = "${self.packages.${system}.ext-pi-permissions}/src/index.ts";
        TZDIR = "${pkgs.tzdata}/share/zoneinfo";
        nativeBuildInputs = [
          pkgs.bun
          pkgs.typescript
          # intercom's Claude registry entry carries `ps -o lstart=` for its
          # pid, which its tests compare against the real thing.
          pkgs.ps
        ];
        PI_CODING_AGENT_SRC = piSrc;
      }
      ''
        set -euo pipefail
        cp -R "$src" work
        chmod -R u+w work
        cd work

        export HOME="$TMPDIR"
        mkdir node_modules
        for d in ${piModules}/*; do ln -s "$d" node_modules/; done
        rm -f node_modules/@ff-labs
        ln -s ${piCustom}/node_modules/@ff-labs node_modules/@ff-labs

        bun test
        cp ${piCustomTsconfig} tsconfig.json
        tsc -p tsconfig.json

        touch $out
      '';

  piMinimapTest =
    let
      piModules = "${self.packages.${system}.coding-agent-bun}/lib/node_modules";
    in
    pkgs.runCommand "pi-nix-pi-minimap-tests"
      {
        src = ../packages/extensions/pi-minimap;
        nativeBuildInputs = [
          pkgs.bun
          pkgs.typescript
        ];
      }
      ''
        set -euo pipefail
        cp -R "$src" work
        chmod -R u+w work
        cd work
        export HOME="$TMPDIR"
        mkdir node_modules
        for d in ${piModules}/*; do ln -s "$d" node_modules/; done
        bun test
        cp ${piCustomTsconfig} tsconfig.json
        tsc -p tsconfig.json
        touch $out
      '';

  # pi-permissions is typechecked the same way, against the pi this flake
  # builds overlaid with its own dependencies. Its vendored engines' own suites
  # run in the permissions-upstream check; bun test runs the tests written for
  # this package.
  piPermissionsTest =
    let
      piModules = "${self.packages.${system}.coding-agent-bun}/lib/node_modules";
      piPermissions = self.packages.${system}.ext-pi-permissions;
    in
    pkgs.runCommand "pi-nix-pi-permissions-tests"
      {
        src = ../packages/extensions/pi-permissions;
        nativeBuildInputs = [
          pkgs.bun
          pkgs.typescript
        ];
      }
      ''
        set -euo pipefail
        cp -R "$src" work
        chmod -R u+w work
        cd work

        export HOME="$TMPDIR"
        mkdir node_modules
        for d in ${piModules}/*; do ln -s "$d" node_modules/; done
        for d in ${piPermissions}/node_modules/*; do
          name=$(basename "$d")
          [ "$name" = .bin ] && continue
          rm -rf "node_modules/$name"
          ln -s "$d" "node_modules/$name"
        done

        bun test
        cp ${piCustomTsconfig} tsconfig.json
        tsc -p tsconfig.json

        touch $out
      '';
in
lib.mapAttrs mkTest {
  pi-notify = ../packages/extensions/pi-notify;
  pi-voice = ../packages/extensions/pi-voice;
  pi-fast = ../packages/extensions/pi-fast;
  pi-foreign-skills = ../packages/extensions/pi-foreign-skills;
}
// {
  pi-custom = piCustomTest;
  pi-minimap = piMinimapTest;
  pi-permissions = piPermissionsTest;
}
