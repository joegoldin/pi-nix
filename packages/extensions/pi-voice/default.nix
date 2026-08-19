{
  lib,
  mkPiExtension,
}:
mkPiExtension {
  pname = "pi-voice";
  version = "0.1.0";

  # First-party, same shape as pi-auto-mode and pi-notify: local source, no
  # tarball, no runtime dependency. audiomemo is not a dependency of this
  # package either: the absolute path to `record` arrives in the environment
  # the module renders, so the extension never searches PATH.
  src = ./.;

  entrypoints = [ "src/index.ts" ];

  meta = {
    description = "Dictation for pi, over audiomemo record --stream";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
