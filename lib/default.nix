# Imported by agent-skills as `piLib`, in the same shape as codex-nix/lib and
# antigravity-cli-nix/lib: `import "${pi-nix}/lib" { inherit pkgs lib; }`.
# claude-nix/lib is called with pkgs alone, so lib defaults from pkgs.
{
  pkgs,
  lib ? pkgs.lib,
}:
let
  mkPiSkill = import ./mkPiSkill.nix { inherit pkgs lib; };
  mkPiPromptTemplate = import ./mkPiPromptTemplate.nix { inherit pkgs lib; };
  mkPiPlugin = import ./mkPiPlugin.nix { inherit pkgs lib; };
in
{
  inherit mkPiSkill mkPiPromptTemplate mkPiPlugin;

  # agent-skills' mkCrossAgentPlugin calls targetLib.mkSkill and
  # targetLib.mkPlugin by those names, so the pi target slots into its
  # targetLibs map with no changes on that side.
  mkSkill = mkPiSkill;
  mkPlugin = mkPiPlugin;
}
