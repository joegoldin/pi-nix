{ pkgs, lib }:
# A real pi package: a directory whose package.json carries the `pi` key. pi
# resolves that manifest when the directory is handed to `--extension`, and
# `keywords: ["pi-package"]` is what marks it as a package to `pi install`.
#
# The passthru mirrors mkPiExtension's contract exactly, so a first-party
# plugin and a pinned npm extension are interchangeable in the module's
# `extensionPackages` list.
{
  name,
  description ? "",
  version ? "0.0.0",
  # Derivations laying files out under the matching top-level directory.
  skills ? [ ],
  prompts ? [ ],
  extensions ? [ ],
  themes ? [ ],
  # Merged into ~/.pi/agent/settings.json when this plugin is enabled.
  settings ? { },
  # Escape hatch for a plugin whose extensions inject no promptSnippet of
  # their own. Normally null — registerTool already supplies guidance.
  promptFragment ? null,
}:
let
  # Only the surfaces this plugin actually ships are declared. An empty array
  # would make pi resolve zero entries and fall through to probing index.ts.
  piManifest =
    lib.optionalAttrs (extensions != [ ]) { extensions = [ "./extensions" ]; }
    // lib.optionalAttrs (skills != [ ]) { skills = [ "./skills" ]; }
    // lib.optionalAttrs (prompts != [ ]) { prompts = [ "./prompts" ]; }
    // lib.optionalAttrs (themes != [ ]) { themes = [ "./themes" ]; };

  manifest = {
    inherit name version description;
    keywords = [ "pi-package" ];
    pi = piManifest;
  };

  manifestDrv = pkgs.runCommand "pi-plugin-${name}-manifest" { } ''
    mkdir -p $out
    cp ${(pkgs.formats.json { }).generate "package.json" manifest} $out/package.json
  '';

  env = pkgs.buildEnv {
    name = "pi-plugin-${name}";
    paths = [ manifestDrv ] ++ skills ++ prompts ++ extensions ++ themes;
    pathsToLink = [
      "/"
    ];
  };
in
env
// {
  passthru = (env.passthru or { }) // {
    # A directory: pi reads the pi manifest above and loads what it declares.
    piEntrypoint = lib.optional (extensions != [ ]) "${env}";
    piSkills = lib.optional (skills != [ ]) "${env}/skills";
    piPrompts = lib.optional (prompts != [ ]) "${env}/prompts";
    inherit settings promptFragment;
    meta = {
      inherit name description;
    };
  };
}
