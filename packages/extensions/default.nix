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

  # Nix-side configuration per extension, merged into settings.json when the
  # extension is enabled. Every entry is `{ }` today: verified on 2026-08-19,
  # none of the twelve pins reads pi's settings.json. pi-mcp-adapter reads
  # ~/.config/mcp/mcp.json and ~/.agents/mcp.json; the @juicesharp packages
  # read their own rpiv-* config; pi-pretty and pi-cache-optimizer both write
  # under getAgentDir(); @czottmann/pi-automode reads
  # ~/.pi/agent/automode.json, which the autoMode option writes through
  # configFiles. The mechanism is here for pins that do, and is exercised by
  # the synthetic case in tests/extensions-test.nix.
  settingsFor = {
    pi-mcp-adapter = { };
    pi-subagents = { };
    pi-background-tasks = { };
    juicesharp-rpiv-ask-user-question = { };
    narumitw-pi-goal = { };
    juicesharp-rpiv-todo = { };
    gotgenes-pi-permission-system = { };
    narumitw-pi-btw = { };
    pi-cache-optimizer = { };
    heyhuynhgiabuu-pi-pretty = { };
  };

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
      settings = settingsFor.${slug} or { };
      extraBuildInputs = extraBuildInputsFor.${slug} or [ ];
      promptFragment = null;
    };
  # First-party extensions. No pin, no lockfile: the source is in this repo and
  # neither package has a runtime dependency, so mkPiExtension's local-src arm
  # copies the tree and stops. They are named the same way as the pinned ones so
  # `extensionPackages` treats every extension alike.
  firstParty = {
    ext-pi-auto-mode = bunPkgs.callPackage ./pi-auto-mode { inherit mkPiExtension; };
    ext-pi-notify = bunPkgs.callPackage ./pi-notify { inherit mkPiExtension; };
    ext-pi-voice = bunPkgs.callPackage ./pi-voice { inherit mkPiExtension; };
  };

  # pi-intercom is pinned like the others but built by its own file, because it
  # is the one package that carries a patch and a configFiles entry. Defined
  # after the generic loop so this definition is the one that wins.
  patched = {
    ext-pi-intercom = bunPkgs.callPackage ./pi-intercom.nix {
      inherit mkPiExtension;
      pin = pins."pi-intercom";
      inherit (bunPkgs.callPackage ./pi-intercom-patches.nix { }) securityPatch;
    };
  };
in
lib.mapAttrs' (name: pin: lib.nameValuePair "ext-${slugOf name}" (mkOne name pin)) pins
// firstParty
// patched
