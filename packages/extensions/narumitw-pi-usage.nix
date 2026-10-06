# @narumitw/pi-usage, from its npm pin, loading its TypeScript source rather
# than the esbuild bundle in dist/: pi loads TypeScript itself, and the patch
# below edits src/. Its one dependency, pi-tui-kit, is imported lazily and comes
# from the vendored lockfile like any pin's.
{
  callPackage,
  mkPiExtension,
  pin,
}:
mkPiExtension {
  pname = "@narumitw/pi-usage";
  inherit (pin)
    version
    url
    hash
    bundled
    entrypoints
    skills
    prompts
    ;
  bunLock = ./narumitw-pi-usage/bun.lock;
  bunNix = ./narumitw-pi-usage/bun.nix;
  patchPhaseExtra = (callPackage ./narumitw-pi-usage-patches.nix { }).reportEvent;
}
