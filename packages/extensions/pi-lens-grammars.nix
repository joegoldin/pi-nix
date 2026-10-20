{
  lib,
  fetchurl,
  writeText,
}:
# npm ships only core grammars. Fetch the complete upstream-pinned set at build
# time: pi-lens's runtime download destination lives in the read-only Nix store.
let
  manifestPath = ./pi-lens/grammars.lock.json;
  manifest = lib.importJSON manifestPath;
  installGrammar =
    name: hash:
    let
      source =
        manifest.overrides.${name} or {
          inherit (manifest) package version;
          url = "https://unpkg.com/${manifest.package}@${manifest.version}/out/${name}";
        };
      wasm = fetchurl {
        inherit (source) url;
        sha256 = lib.removePrefix "sha256:" hash;
      };
      provenance = writeText "${name}.json" (
        builtins.toJSON {
          npmPackage = source.package;
          inherit (source) version;
          sha256 = hash;
        }
      );
    in
    ''
      cp ${wasm} "grammars/${name}"
      cp ${provenance} "grammars/${name}.json"
    '';
in
''
  # Fail on an upstream pin change unless the vendored manifest was updated too.
  cmp scripts/grammars.lock.json ${manifestPath}
  mkdir -p grammars
  ${lib.concatStrings (lib.mapAttrsToList installGrammar manifest.grammars)}
''
