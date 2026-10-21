{
  lib,
  mkPiExtension,
}:
mkPiExtension {
  pname = "pi-fast";
  version = "0.1.0";
  src = ./.;
  entrypoints = [ "src/index.ts" ];

  meta = {
    description = "Session-local OpenAI priority inference toggle for Pi";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
