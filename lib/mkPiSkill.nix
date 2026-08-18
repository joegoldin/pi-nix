{ pkgs, lib }:
# Agent Skills format, which pi consumes unchanged. pi is more permissive than
# Claude Code — it does not require `name` to match the parent directory — but
# we write the matching directory anyway so the same tree is valid for both.
{
  name,
  description,
  # List of tool names, or a pre-joined string. Entries containing spaces
  # (e.g. "Bash(git log:*)") force a comma join; a space join would shear them
  # mid-entry.
  allowed-tools ? [ ],
  # Any other SKILL.md frontmatter field pi accepts: license, compatibility,
  # metadata, disable-model-invocation.
  extraFrontmatter ? { },
  # Extra files copied alongside SKILL.md (scripts/, references/, assets/).
  extraFiles ? [ ],
}:
body:
let
  toolsValue =
    if builtins.isList allowed-tools then
      lib.concatStringsSep (
        if lib.any (t: lib.hasInfix " " t) allowed-tools then ", " else " "
      ) allowed-tools
    else
      allowed-tools;

  formatValue =
    key: value:
    if builtins.isBool value then "${key}: ${lib.boolToString value}" else "${key}: ${toString value}";

  fields = [
    "name: ${name}"
    "description: ${description}"
  ]
  ++ lib.optional (allowed-tools != [ ] && allowed-tools != "") "allowed-tools: ${toolsValue}"
  ++ lib.mapAttrsToList formatValue extraFrontmatter;

  skillMd = pkgs.writeText "pi-skill-${name}-md" ''
    ---
    ${lib.concatStringsSep "\n" fields}
    ---

    ${body}
  '';

  copyExtras = lib.concatMapStringsSep "\n" (f: "cp -r ${f} $out/skills/${name}/") extraFiles;
in
pkgs.runCommand "pi-skill-${name}" { } ''
  mkdir -p $out/skills/${name}
  cp ${skillMd} $out/skills/${name}/SKILL.md
  ${copyExtras}
''
