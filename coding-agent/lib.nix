{
  self,
  lib,
  jail-nix,
}:

{
  mkAgentContainerBundle = import ./agent-container-bundle.nix {
    inherit lib self;
  };

  mkCodingAgent =
    {
      pkgs,
      modules ? [ ],
      extraSpecialArgs ? { },
    }:
    let
      specialArgs = {
        inherit self pkgs;
      }
      // extraSpecialArgs;
      evaluatedModules = [
        (import ./options.nix { inherit self jail-nix; })
        (import ./extra-options.nix { inherit self; })
      ]
      ++ modules;
      evaluated = lib.evalModules {
        inherit specialArgs;
        modules = evaluatedModules;
      };

      inherit (evaluated.config.pi.coding-agent) finalPackage finalRules finalArgs;
    in
    {
      inherit (evaluated) config options;
      coding-agent = finalPackage;
      package = finalPackage;
      rules = finalRules;
      args = finalArgs;
      moduleProvenance = {
        modules = evaluatedModules;
        inherit specialArgs;
        config = evaluated.config // {
          inherit (evaluated) _module;
        };
        inherit (evaluated) options;
      };
    };
}
