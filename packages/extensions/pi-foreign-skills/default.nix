{
  lib,
  mkPiExtension,
}:
mkPiExtension {
  pname = "pi-foreign-skills";
  version = "0.1.0";

  # First-party, same shape as pi-notify: local source, no runtime dependency.
  # It answers one event with paths and shells out to nothing.
  src = ./.;

  entrypoints = [ "src/index.ts" ];

  meta = {
    description = "Load .claude/skills from the launch directory, which pi's own skill roots do not cover";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
