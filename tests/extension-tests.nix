# Test derivations for the first-party extensions, `pi-auto-mode` and
# `pi-notify`. Both run twice over the same tree:
#
#   bun test — the unit suite. No node_modules and no network: the packages
#     declare no dependencies at all, and `import type` from @earendil-works/*
#     is erased before bun ever tries to resolve it.
#
#   tsc --strict — the entrypoint against pi's own published .d.ts. That is what
#     pins ctx.modelRegistry.complete, ctx.signal, pi.events.emit and
#     ToolCallEventResult to the shapes pi really has rather than to the shapes
#     this fork believes it has. A pi bump that changes one fails here.
#
# PI_CODING_AGENT_SRC points at the same fetchFromGitHub output
# packages.coding-agent builds from, which turns pi-contract.test.ts from a
# skipped file into a differential test against pi's real tool schemas.
{
  pkgs,
  self,
  ...
}:
let
  inherit (pkgs) lib;
  inherit (pkgs.stdenv.hostPlatform) system;

  piSrc = self.packages.${system}.coding-agent.src;

  # The npm tarball, not the GitHub source: only the published package carries
  # dist/*.d.ts, and the published types are what a third-party extension author
  # would compile against. Version and hash track VERSION.json's rev by hand;
  # `nix run .#update` does not touch them, so a pi bump that moves the API
  # surface shows up as a typecheck failure rather than as silent drift.
  piTypes = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.84.2.tgz";
    hash = "sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==";
  };

  # Both extensions read a config file with node:fs, so tsc needs node's types.
  # skipLibCheck covers undici-types, which this tarball references and which is
  # not fetched.
  nodeTypes = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@types/node/-/node-22.18.12.tgz";
    hash = "sha512-BICHQ67iqxQGFSzfCFTT7MRQ5XcBjG5aeKh5Ok38UBbPe5fxTyE+aHFxwVrGyr8GNlqFMLKD1D3P2K/1ks8tog==";
  };

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
        typeRoots = [ "./types" ];
        types = [ "node" ];
        baseUrl = ".";
        paths = {
          "@earendil-works/pi-coding-agent" = [ "./pi-types/dist/index.d.ts" ];
        };
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

        # bun writes nothing and fetches nothing: neither package declares a
        # dependency, so a lockfile would be empty and an install a no-op.
        bun test

        mkdir -p pi-types types/node
        tar -xzf ${piTypes} -C pi-types --strip-components=1
        tar -xzf ${nodeTypes} -C types/node --strip-components=1
        cp ${tsconfig} tsconfig.json
        tsc -p tsconfig.json

        touch $out
      '';
in
lib.mapAttrs mkTest {
  pi-auto-mode = ../packages/extensions/pi-auto-mode;
  pi-notify = ../packages/extensions/pi-notify;
}
