{ pkgs, lib }:
# pi prompt templates are slash commands: the filename becomes the command, so
# `review.md` is `/review`. Arguments use shell syntax ($1, $@, ${1:-default}),
# which is substituted by pi at expansion time, not here.
{
  name,
  # Shown in autocomplete. When omitted pi falls back to the first non-empty
  # line of the body, so an absent description is a valid choice, not a defect.
  description ? null,
  # <angle brackets> for required arguments, [square brackets] for optional.
  argument-hint ? null,
  extraFrontmatter ? { },
}:
body:
let
  formatValue =
    key: value:
    if builtins.isBool value then "${key}: ${lib.boolToString value}" else "${key}: ${toString value}";

  present =
    lib.filterAttrs (_: v: v != null) {
      inherit description;
      # Quoted so a hint that starts with `[` is not parsed as a YAML flow
      # sequence.
      argument-hint = if argument-hint == null then null else ''"${argument-hint}"'';
    }
    // extraFrontmatter;

  fields = lib.mapAttrsToList formatValue present;

  # No fields means no delimiters at all: an empty `---\n---` block would make
  # pi read the closing delimiter as the description's first line.
  frontmatter =
    if fields == [ ] then "" else "---\n" + lib.concatStringsSep "\n" fields + "\n---\n\n";

  file = pkgs.writeText "pi-prompt-${name}-md" (frontmatter + body + "\n");
in
pkgs.runCommand "pi-prompt-${name}" { } ''
  mkdir -p $out/prompts
  cp ${file} $out/prompts/${name}.md
''
