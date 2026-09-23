# Keep the permission-chain and shared-statusline integration as patches on the
# npm release, so extensions.json is also the version source for auto mode.
{
  patch,
  mkPiExtension,
  pin,
  ...
}:
mkPiExtension {
  pname = "@czottmann/pi-automode";
  inherit (pin)
    version
    url
    hash
    bundled
    entrypoints
    skills
    prompts
    ;
  bunLock = ./czottmann-pi-automode/bun.lock;
  bunNix = ./czottmann-pi-automode/bun.nix;
  patchPhaseExtra = ''
    ${patch}/bin/patch -p1 < ${./pi-automode-integration.patch}
    ${patch}/bin/patch -p1 < ${./pi-automode-session-service.patch}
    ${patch}/bin/patch -p1 < ${./pi-automode-deterministic-gate.patch}
  '';
}
