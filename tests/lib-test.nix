# Builder tests are shell assertions against built outputs rather than eval
# assertions, because what matters is the bytes pi will read: the SKILL.md
# frontmatter, the prompt filename, and the pi manifest inside package.json.
{ pkgs, ... }:
let
  lib = pkgs.lib;
  piLib = import ../lib { inherit pkgs lib; };

  skill = piLib.mkPiSkill {
    name = "demo-skill";
    description = "A demo skill used by the pi-nix builder tests.";
    allowed-tools = [
      "read"
      "Bash(git log:*)"
    ];
    extraFrontmatter.disable-model-invocation = true;
  } "Body of the demo skill.";

  bareSkill = piLib.mkPiSkill {
    name = "bare-skill";
    description = "No tools declared.";
  } "Bare body.";

  prompt = piLib.mkPiPromptTemplate {
    name = "review";
    description = "Review staged git changes";
    argument-hint = "[file-pattern]";
  } "Review $1 and summarise $@.";

  barePrompt = piLib.mkPiPromptTemplate { name = "bare"; } "No frontmatter here.";

  plugin = piLib.mkPiPlugin {
    name = "demo-plugin";
    description = "A demo pi package.";
    version = "1.2.3";
    skills = [ skill ];
    prompts = [ prompt ];
  };
in
pkgs.runCommand "pi-nix-lib-tests" { nativeBuildInputs = [ pkgs.jq ]; } ''
  set -euo pipefail

  # ── mkPiSkill ────────────────────────────────────────────────────────────
  md=${skill}/skills/demo-skill/SKILL.md
  test -f "$md"
  grep -qxF 'name: demo-skill' "$md"
  grep -qxF 'description: A demo skill used by the pi-nix builder tests.' "$md"
  # Entries containing spaces must be comma-joined; a space join would shear
  # "Bash(git log:*)" mid-entry.
  grep -qxF 'allowed-tools: read, Bash(git log:*)' "$md"
  grep -qxF 'disable-model-invocation: true' "$md"
  grep -qxF 'Body of the demo skill.' "$md"

  # An empty allowed-tools line would restrict the skill to no tools, so the
  # key must be absent rather than empty.
  bare=${bareSkill}/skills/bare-skill/SKILL.md
  test -f "$bare"
  ! grep -q 'allowed-tools' "$bare"

  # ── mkPiPromptTemplate ───────────────────────────────────────────────────
  # The filename is the slash command, so it must be exactly <name>.md.
  p=${prompt}/prompts/review.md
  test -f "$p"
  grep -qxF 'description: Review staged git changes' "$p"
  grep -qxF 'argument-hint: "[file-pattern]"' "$p"
  grep -qxF 'Review $1 and summarise $@.' "$p"

  # With no frontmatter fields pi uses the first non-empty line as the
  # description, so no delimiters may be emitted at all.
  bp=${barePrompt}/prompts/bare.md
  test -f "$bp"
  ! grep -q -- '---' "$bp"

  # ── mkPiPlugin ───────────────────────────────────────────────────────────
  pj=${plugin}/package.json
  test -f "$pj"
  test "$(jq -r .name "$pj")" = demo-plugin
  test "$(jq -r .version "$pj")" = 1.2.3
  test "$(jq -r '.keywords[0]' "$pj")" = pi-package
  test "$(jq -r '.pi.skills[0]' "$pj")" = ./skills
  test "$(jq -r '.pi.prompts[0]' "$pj")" = ./prompts
  # No extensions were passed, so the key must be absent — an empty array
  # would make pi resolve zero entries and fall through to index.ts probing.
  test "$(jq -r '.pi | has("extensions") | tostring' "$pj")" = false
  test -f ${plugin}/skills/demo-skill/SKILL.md
  test -f ${plugin}/prompts/review.md

  touch $out
''
