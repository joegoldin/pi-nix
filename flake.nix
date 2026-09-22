{
  description = "pi-nix: a Nix flake for the pi coding agent, with pinned ecosystem extensions and agent-stack integration";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";

    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";

    # Nixpkgs 26.11 dropped Intel macOS. Keep it on the final supported branch,
    # which receives security fixes through the end of 2026.
    nixpkgs-x86_64-darwin.url = "github:nixos/nixpkgs?ref=nixpkgs-26.05-darwin";

    bun2nix = {
      url = "github:nix-community/bun2nix?ref=2.1.0";
      inputs = {
        flake-parts.follows = "flake-parts";
        nixpkgs.follows = "nixpkgs";
      };
    };

    bun2nix-x86_64-darwin = {
      url = "github:nix-community/bun2nix?ref=2.1.0";
      inputs = {
        flake-parts.follows = "flake-parts";
        nixpkgs.follows = "nixpkgs-x86_64-darwin";
        systems.follows = "bun2nix/systems";
      };
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
    inputs@{
      flake-parts,
      nixpkgs,
      nixpkgs-x86_64-darwin,
      bun2nix,
      bun2nix-x86_64-darwin,
      jail-nix,
      ...
    }:
    let
      current = builtins.fromJSON (builtins.readFile ./VERSION.json);
      inherit (current) rev hash;
      inherit (current.projects.coding-agent) npmDepsHash;
      version = nixpkgs.lib.removePrefix "v" rev;

      nixpkgsFor = system: if system == "x86_64-darwin" then nixpkgs-x86_64-darwin else nixpkgs;
      pkgsFor = system: import (nixpkgsFor system) { inherit system; };

      bun2nixFor = system: if system == "x86_64-darwin" then bun2nix-x86_64-darwin else bun2nix;

      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      inherit systems;

      perSystem =
        { system, ... }:
        let
          pkgs = pkgsFor system;
          bunPkgs = import (nixpkgsFor system) {
            inherit system;
            overlays = [ (bun2nixFor system).overlays.default ];
          };

          src = pkgs.fetchFromGitHub {
            owner = "earendil-works";
            repo = "pi";
            inherit rev hash;
          };

          syncUpstream = import ./sync-upstream.nix {
            inherit pkgs;
            bun2nix = (bun2nixFor system).packages.${system}.bun2nix;
          };

          regenerateModels = import ./regenerate-models.nix {
            inherit pkgs;
          };

          updateExtensions = import ./update-extensions.nix {
            pkgs = bunPkgs;
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
          _module.args.pkgs = pkgs;

          packages = rec {
            default = coding-agent;

            coding-agent = pkgs.callPackage ./coding-agent/package.nix {
              inherit src version npmDepsHash;
            };
            coding-agent-bun = bunPkgs.callPackage ./coding-agent/package-bun.nix {
              inherit src version;
            };

            docs-md =
              let
                agent = inputs.self.lib.mkCodingAgent { inherit pkgs; };
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
          // import ./packages/extensions { inherit pkgs bunPkgs; };

          # bun2nix's overlay, because tests/extensions-test.nix instantiates
          # mkPiExtension against this pkgs. The overlay only adds `bun2nix`,
          # so every other check sees the nixpkgs it saw before.
          checks = import ./tests {
            pkgs = bunPkgs;
            inherit (inputs) self;
            inherit jail-nix;
          };

          formatter = pkgs.nixfmt;

          apps = {
            update = {
              type = "app";
              program = "${update}/bin/pi-update";
              meta.description = "Update pi and regenerate its model data";
            };
            sync-upstream = {
              type = "app";
              program = "${syncUpstream}/bin/pi-sync-upstream";
              meta.description = "Update pi's upstream lockfiles and version metadata";
            };
            regenerate-models = {
              type = "app";
              program = "${regenerateModels}/bin/pi-regenerate-models";
              meta.description = "Regenerate pi's bundled AI model data";
            };
            update-extensions = {
              type = "app";
              program = "${updateExtensions}/bin/pi-update-extensions";
              meta.description = "Bump every pinned pi extension";
            };
            scan = {
              type = "app";
              program = "${scan}/bin/pi-scan";
              meta.description = "Run repository security scans";
            };
          };
        };

      flake = rec {
        lib =
          let
            coding-agent = import ./coding-agent/lib.nix {
              inherit (inputs) self;
              inherit jail-nix;
              inherit (nixpkgs) lib;
            };
          in
          {
            inherit (coding-agent) mkCodingAgent;

            # Per-system because the builders need pkgs. agent-skills imports
            # `${pi-nix}/lib` directly rather than going through this, but
            # exposing it keeps `nix eval .#lib.builders.x86_64-linux` honest.
            builders = nixpkgs.lib.genAttrs systems (system: import ./lib { pkgs = pkgsFor system; });
          };

        nixosModules = rec {
          default = coding-agent;
          coding-agent = import ./coding-agent/module.nix {
            inherit (inputs) self;
            inherit jail-nix;
          };
        };

        homeModules = rec {
          default = coding-agent;
          coding-agent = import ./coding-agent/home-manager.nix {
            inherit (inputs) self;
            inherit jail-nix;
          };
        };
        homeManagerModules = homeModules;

        overlays.default =
          _final: prev:
          let
            inherit (prev.stdenv.hostPlatform) system;
          in
          {
            pi-coding-agent = inputs.self.packages.${system}.coding-agent;
            pi-coding-agent-bun = inputs.self.packages.${system}.coding-agent-bun;
          };
      };
    };
}
