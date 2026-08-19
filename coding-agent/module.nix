{ self, jail-nix }:
{
  config,
  lib,
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
    (import ./extra-options.nix {
      inherit self;
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

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        environment.systemPackages = [ cfg.finalPackage ];
      }
    ]
  );
}
