{
  pkgs,
  # nixpkgs with bun2nix.overlays.default applied. Defaults to pkgs so a caller
  # that already applied the overlay can pass one argument.
  bunPkgs ? pkgs,
  lib ? pkgs.lib,
}:
# Every pin in extensions.json becomes packages.ext-<slug>. The pin file is
# read with fromJSON/readFile, never through IFD, so `nix flake show` stays
# evaluable offline.
let
  pins = builtins.fromJSON (builtins.readFile ../../extensions.json);

  mkPiExtension = bunPkgs.callPackage ./mk-pi-extension.nix { };

  slugOf = name: lib.replaceStrings [ "@" "/" ] [ "" "-" ] name;

  # Libraries autoPatchelfHook must be able to find beyond stdenv.cc.cc.lib.
  # pi-mcp-adapter reaches `recheck`, a GraalVM native-image binary published
  # by recheck-linux-x64, and that binary links libz. Every other native file
  # across the pin set resolves against libc/libgcc_s/libstdc++ alone.
  extraBuildInputsFor = {
    pi-mcp-adapter = [ bunPkgs.zlib ];
  };

  mkOne =
    name: pin:
    let
      slug = slugOf name;
    in
    mkPiExtension {
      pname = name;
      inherit (pin)
        version
        url
        hash
        bundled
        entrypoints
        skills
        prompts
        ;
      bunLock = if pin.bundled then null else ./. + "/${slug}/bun.lock";
      bunNix = if pin.bundled then null else ./. + "/${slug}/bun.nix";
      extraBuildInputs = extraBuildInputsFor.${slug} or [ ];
      promptFragment = null;
    };
  # First-party extensions. No pin, no lockfile: the source is in this repo and
  # neither package has a runtime dependency, so mkPiExtension's local-src arm
  # copies the tree and stops. They are named the same way as the pinned ones so
  # `extensionPackages` treats every extension alike.
  firstParty = {
    ext-pi-notify = bunPkgs.callPackage ./pi-notify { inherit mkPiExtension; };
    ext-pi-voice = bunPkgs.callPackage ./pi-voice { inherit mkPiExtension; };
    ext-pi-foreign-skills = bunPkgs.callPackage ./pi-foreign-skills { inherit mkPiExtension; };
    ext-pi-extras = bunPkgs.callPackage ./pi-extras { inherit mkPiExtension; };
  };

  # These npm packages need integration patches in addition to the generic build.
  patched = {
    ext-pi-intercom = bunPkgs.callPackage ./pi-intercom.nix {
      inherit mkPiExtension;
      pin = pins."pi-intercom";
      inherit (bunPkgs.callPackage ./pi-intercom-patches.nix { }) securityPatch;
    };
    ext-pi-cache-optimizer = bunPkgs.callPackage ./pi-cache-optimizer.nix {
      inherit mkPiExtension;
      pin = pins."pi-cache-optimizer";
      inherit (bunPkgs.callPackage ./pi-cache-optimizer-patches.nix { }) suppressibleStatusSlot;
    };
    ext-gotgenes-pi-permission-system = bunPkgs.callPackage ./gotgenes-pi-permission-system.nix {
      inherit mkPiExtension;
      pin = pins."@gotgenes/pi-permission-system";
      inherit (bunPkgs.callPackage ./gotgenes-pi-permission-system-patches.nix { })
        configurableDelegationEnvelope
        ;
    };
    ext-czottmann-pi-automode = bunPkgs.callPackage ./czottmann-pi-automode.nix {
      inherit mkPiExtension;
      pin = pins."@czottmann/pi-automode";
    };
  };
in
lib.mapAttrs' (name: pin: lib.nameValuePair "ext-${slugOf name}" (mkOne name pin)) pins
// firstParty
// patched
