{
  lib,
  mkPiExtension,
}:
mkPiExtension {
  pname = "pi-custom";
  version = "0.1.0";

  # First-party, with one dependency of its own: FFF's native file index,
  # vendored through bun.lock like a pinned extension's. Everything else it
  # imports (pi-coding-agent, pi-tui, pi-ai) pi supplies.
  src = ./.;
  bunLock = ./bun.lock;
  bunNix = ./bun.nix;

  entrypoints = [ "src/index.ts" ];

  meta = {
    description = "This setup's own pi features: interface, prompt handling and agent tools";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
