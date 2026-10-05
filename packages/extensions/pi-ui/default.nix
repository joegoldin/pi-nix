{
  lib,
  mkPiExtension,
}:
mkPiExtension {
  pname = "pi-ui";
  version = "0.1.0";

  # First-party, but unlike pi-extras it has a dependency of its own: FFF's
  # native file index, vendored through bun.lock like a pinned extension's.
  # Everything else it imports (pi-coding-agent, pi-tui) pi supplies.
  src = ./.;
  bunLock = ./bun.lock;
  bunNix = ./bun.nix;

  entrypoints = [ "src/index.ts" ];

  meta = {
    description = "Claude Code-style tool cards, /ui, /context, @ references and FFF search for pi";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
