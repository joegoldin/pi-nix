{
  lib,
  mkPiExtension,
}:
mkPiExtension {
  pname = "pi-notify";
  version = "0.1.0";

  # First-party, same shape as pi-auto-mode: local source, no tarball, no
  # runtime dependency. The notifier binary is not a dependency of this package
  # either — its absolute path arrives in the config the module renders.
  src = ./.;

  entrypoints = [ "src/index.ts" ];

  meta = {
    description = "Desktop notifications for pi: permission prompts, agent settled, long-running tool calls";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
