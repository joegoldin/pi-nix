{
  description = "pi-nix: a Nix flake for the pi coding agent, with pinned ecosystem extensions and agent-stack integration";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    systems.url = "github:nix-systems/default";
    bun2nix = {
      url = "github:nix-community/bun2nix?ref=2.1.0";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.systems.follows = "systems";
    };
    jail-nix.url = "sourcehut:~alexdavid/jail.nix";
    agent-statusline = {
      url = "github:joegoldin/agent-statusline";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  nixConfig = {
    extra-substituters = [
      "https://pi.cachix.org"
      "https://nix-community.cachix.org"
    ];
    extra-trusted-public-keys = [
      "pi.cachix.org-1:lGeoGJaZ5ZDabuRzkcD5EBTNnDM4HJ1vqeOxlWk1Flk="
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  outputs =
    {
      self,
      nixpkgs,
      systems,
      bun2nix,
      jail-nix,
      agent-statusline,
    }:
    let
      current = builtins.fromJSON (builtins.readFile ./VERSION.json);
      inherit (current) rev hash;
      inherit (current.projects.coding-agent) npmDepsHash;
      version = nixpkgs.lib.removePrefix "v" rev;

      forEachSystem = nixpkgs.lib.genAttrs (import systems);
    in
    rec {
      packages = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          bunPkgs = import nixpkgs {
            inherit system;
            overlays = [ bun2nix.overlays.default ];
          };

          src = pkgs.fetchFromGitHub {
            owner = "earendil-works";
            repo = "pi";
            inherit rev hash;
          };

        in
        rec {
          default = coding-agent;

          coding-agent = pkgs.callPackage ./coding-agent/package.nix {
            inherit src version npmDepsHash;
          };
          coding-agent-bun = bunPkgs.callPackage ./coding-agent/package-bun.nix {
            inherit src version;
          };

          docs-md =
            let
              agent = self.lib.mkCodingAgent { inherit pkgs; };
              docs = pkgs.nixosOptionsDoc {
                options = builtins.removeAttrs agent.options [ "_module" ];
              };
            in
            pkgs.runCommand "pi-options.md" { }
              # bash
              ''
                mkdir -p $out
                cp ${docs.optionsCommonMark} $out/index.md
              '';

          docs-html =
            pkgs.runCommand "pi-options.html"
              {
                nativeBuildInputs = [ pkgs.pandoc ];
              }
              # bash
              ''
                mkdir -p $out
                pandoc \
                  --standalone \
                  --metadata title="pi.nix options" \
                  ${docs-md}/index.md \
                  --output $out/index.html
              '';
        }
        // import ./packages/extensions { inherit pkgs bunPkgs; }
      );

      checks = forEachSystem (
        system:
        let
          # bun2nix's overlay, because tests/extensions-test.nix instantiates
          # mkPiExtension against this pkgs. The overlay only adds `bun2nix`,
          # so every other check sees the nixpkgs it saw before.
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ bun2nix.overlays.default ];
          };
        in
        import ./tests {
          inherit pkgs self jail-nix;
        }
      );

      lib =
        let
          coding-agent = import ./coding-agent/lib.nix {
            inherit self jail-nix;
            inherit (nixpkgs) lib;
          };
        in
        {
          inherit (coding-agent) mkCodingAgent;

          # Per-system because the builders need pkgs. agent-skills imports
          # `${pi-nix}/lib` directly rather than going through this, but
          # exposing it keeps `nix eval .#lib.builders.x86_64-linux` honest.
          builders = forEachSystem (
            system:
            import ./lib {
              pkgs = import nixpkgs { inherit system; };
            }
          );
        };

      nixosModules = rec {
        default = coding-agent;
        coding-agent = import ./coding-agent/module.nix {
          inherit self jail-nix;
        };
      };

      homeModules = rec {
        default = coding-agent;
        coding-agent = import ./coding-agent/home-manager.nix {
          inherit self jail-nix;
        };
      };
      homeManagerModules = homeModules;

      overlays = {
        default =
          _final: prev:
          let
            inherit (prev.stdenv.hostPlatform) system;
          in
          {
            pi-coding-agent = self.packages.${system}.coding-agent;
            pi-coding-agent-bun = self.packages.${system}.coding-agent-bun;
          };
      };

      formatter = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixfmt
      );

      apps = forEachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ bun2nix.overlays.default ];
          };

          syncUpstream = import ./sync-upstream.nix {
            inherit pkgs;
            bun2nix = bun2nix.packages.${system}.bun2nix;
          };

          regenerateModels = import ./regenerate-models.nix {
            inherit pkgs;
          };

          updateExtensions = import ./update-extensions.nix {
            inherit pkgs;
          };

          update = import ./update.nix {
            inherit
              pkgs
              regenerateModels
              syncUpstream
              updateExtensions
              ;
          };

          scan = import ./scan.nix { inherit pkgs; };
        in
        {
          update = {
            type = "app";
            program = "${update}/bin/pi-update";
          };
          sync-upstream = {
            type = "app";
            program = "${syncUpstream}/bin/pi-sync-upstream";
          };
          regenerate-models = {
            type = "app";
            program = "${regenerateModels}/bin/pi-regenerate-models";
          };
          update-extensions = {
            type = "app";
            program = "${updateExtensions}/bin/pi-update-extensions";
          };
          scan = {
            type = "app";
            program = "${scan}/bin/pi-scan";
          };
        }
      );
    };
}
