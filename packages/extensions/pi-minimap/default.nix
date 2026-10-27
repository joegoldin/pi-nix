{
  lib,
  mkPiExtension,
}:
mkPiExtension {
  pname = "pi-minimap";
  version = "0.1.0";
  src = ./.;
  entrypoints = [ "src/index.ts" ];

  meta = {
    description = "Bounded source-linked conversation minimap for Pi";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
