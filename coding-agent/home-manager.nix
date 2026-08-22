{ self, jail-nix }:
{
  config,
  lib,
  osConfig,
  ...
}:

let
  cfg = config.programs.pi.coding-agent;
in
{
  imports = [
    (import ./options.nix {
      inherit self jail-nix;
      optionPath = [
        "programs"
        "pi"
        "coding-agent"
      ];
    })
  ];

  options.programs.pi.coding-agent = {
    enable = lib.mkEnableOption "pi agent";
  };

  config = lib.mkMerge [
    {
      programs.pi.coding-agent.wsl = osConfig.wsl.enable or false;
    }
    (lib.mkIf cfg.enable {
      home.packages = [ cfg.finalPackage ];
    })
  ];
}
