{
  lib,
  mkPiExtension,
}:
mkPiExtension {
  pname = "pi-extras";
  version = "0.1.0";

  # First-party, same shape as pi-notify and pi-voice: local source, no tarball,
  # no runtime dependency. The clipboard binary is not a dependency of this
  # package either — its absolute path arrives in PI_EXTRAS_CLIPBOARD, and
  # without one the copy feature drops rather than the extension.
  src = ./.;

  entrypoints = [ "src/index.ts" ];

  meta = {
    description = "Prompt stash, chord keybindings, registers, and session shortcuts for pi";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
