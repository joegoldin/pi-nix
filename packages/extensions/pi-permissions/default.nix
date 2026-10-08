{
  lib,
  mkPiExtension,
}:
mkPiExtension {
  pname = "pi-permissions";
  version = "0.1.0";

  # First-party, with the vendored engines' dependencies vendored through
  # bun.lock like a pinned extension's: tree-sitter with its WASM grammars,
  # zod and unbash. Everything else it imports (pi-coding-agent, pi-tui,
  # pi-ai) pi supplies.
  src = ./.;
  bunLock = ./bun.lock;
  bunNix = ./bun.nix;

  entrypoints = [ "src/index.ts" ];
  # Auto mode's diagnostics skill, with the docs it reads under docs/auto.
  skills = [ "skills" ];

  meta = {
    description = "Permissions and auto mode for pi in one extension";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
