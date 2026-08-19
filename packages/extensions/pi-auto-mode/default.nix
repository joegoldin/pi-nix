{
  lib,
  mkPiExtension,
}:
mkPiExtension {
  pname = "pi-auto-mode";
  version = "0.1.0";

  # First-party: the source is in this repo, so there is no npm tarball to fetch
  # and no bun.lock to vendor. pi loads .ts directly through jiti, and this
  # extension has no runtime dependencies — it imports from @earendil-works/*
  # with `import type` only, which TypeScript erases.
  src = ./.;

  entrypoints = [ "src/index.ts" ];

  meta = {
    description = "Claude-Code-style auto mode for pi: deterministic rules plus a fail-closed model classifier";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
