{
  lib,
  stdenv,
  fetchurl,
  runCommand,
  callPackage,
  bun,
  bun2nix,
  autoPatchelfHook,
}:
# One pi extension: either a pinned npm tarball, or a first-party source tree in
# this repo when `src` is set.
#
# `bundled` decides how node_modules is obtained:
#
#   true  — the tarball already carries everything it needs, or needs nothing.
#           fetchurl + untar, no bun at all.
#   false — the tarball ships source against unvendored dependencies, so
#           bun2nix's hook materialises node_modules from a vendored bun.lock
#           and the bun.nix generated from it. `nix run .#update-extensions`
#           regenerates both.
#
# Design assumption A4 predicted `bundled = true` would be the common case
# because packages would ship a self-contained dist. No pin ships one. The
# branch survives for an unrelated reason: pi-cache-optimizer and
# @czottmann/pi-automode have zero runtime dependencies, so there is nothing
# for bun to install.
{
  pname,
  version,
  # A local source tree, for the first-party extensions this repo carries. When
  # set, `url`/`hash`/`bunLock`/`bunNix` are all unused: there is no tarball to
  # fetch and, because a first-party extension imports from @earendil-works/*
  # with `import type` only, nothing to install either.
  src ? null,
  # npm dist.tarball
  url ? null,
  # npm dist.integrity, usable verbatim as a Nix SRI hash
  hash ? null,
  bundled ? false,
  # Vendored bun.lock and the bun2nix-generated dep set built from it.
  bunLock ? null,
  bunNix ? null,
  # Paths relative to the package root. Empty — the normal case — means "hand
  # pi the package root and let resolveExtensionEntries read the pi manifest
  # in package.json", which is what makes multi-entrypoint packages like
  # pi-background-tasks work without listing anything here.
  entrypoints ? [ ],
  skills ? [ ],
  prompts ? [ ],
  # Merged into ~/.pi/agent/settings.json when this extension is enabled.
  # Carrying config on the derivation lets the module compute settings from
  # *which* extensions are enabled, so adding or removing one is a single list
  # edit with no dangling config.
  settings ? { },
  # Extension-owned config files. Key is a path relative to
  # $PI_CODING_AGENT_DIR; value is any JSON-serialisable attrset.
  #
  # settings.json is not the only configuration surface an extension reads, and
  # for some packages it is the wrong one. pi-intercom reads
  # $PI_CODING_AGENT_DIR/intercom/config.json, and its inboundTrigger setting,
  # which decides whether an unauthenticated local peer may start a model turn
  # in this session, has no environment override at all. Without this field
  # that default cannot be set from Nix.
  configFiles ? { },
  # Shell appended to the unpack/patch phase, run with the package root as the
  # working directory. Written with substituteInPlace --replace-fail so an
  # upstream edit that moves a patch target breaks the build rather than
  # silently reverting whatever the patch was protecting.
  patchPhaseExtra ? "",
  # Escape hatch for an extension that supplies no promptSnippet or
  # promptGuidelines of its own. Normally null.
  promptFragment ? null,
  # Extra libraries autoPatchelfHook must be able to find. Empty for every pin
  # in the initial set: the two with native code (@napi-rs/keyring under
  # pi-mcp-adapter, ffi-rs under pi-pretty) need only libc, libgcc_s, and
  # libstdc++, which stdenv.cc.cc.lib already supplies.
  extraBuildInputs ? [ ],
  meta ? { },
}:
let
  slug = lib.replaceStrings [ "@" "/" ] [ "" "-" ] pname;

  normalisePackageJson = callPackage ./normalise-package-json.nix { };

  tarball = fetchurl {
    inherit url hash;
    name = "${slug}-${version}.tgz";
  };

  drv =
    if src != null then
      # First-party. Test files and the typecheck config are dropped: what pi
      # loads is the shipped tree, and pi has neither a test runner nor tsc.
      runCommand "pi-ext-${slug}-${version}" { } ''
        mkdir -p $out
        cp -R ${src}/. $out/
        chmod -R u+w $out
        find $out -name '*.test.ts' -delete
        find $out -name '*.nix' -delete
        rm -f $out/tsconfig.json
        ${lib.optionalString (patchPhaseExtra != "") "cd $out"}
        ${patchPhaseExtra}
      ''
    else if bundled then
      runCommand "pi-ext-${slug}-${version}" { src = tarball; } ''
        mkdir -p $out
        tar -xzf $src -C $out --strip-components=1
        chmod -R u+w $out
        ${lib.optionalString (patchPhaseExtra != "") "cd $out"}
        ${patchPhaseExtra}
      ''
    else
      stdenv.mkDerivation {
        pname = "pi-ext-${slug}";
        inherit version;
        src = tarball;

        nativeBuildInputs = [
          bun2nix.hook
          bun
        ]
        # Prebuilt .node files arrive with an empty RPATH and DT_NEEDED on
        # libgcc_s/libstdc++/libc, none of which resolve on NixOS. Verified
        # against @yuuang/ffi-rs-linux-x64-gnu, which pi-pretty pulls in
        # transitively. macOS dylibs need no equivalent.
        ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

        buildInputs = lib.optionals stdenv.hostPlatform.isLinux ([ stdenv.cc.cc.lib ] ++ extraBuildInputs);

        # bun installs both the gnu and the musl build of a napi platform
        # package, because `os` and `cpu` cannot express libc. The musl .node
        # is never dlopened on a glibc host — ffi-rs selects its variant by
        # detecting libc at load time — but autoPatchelfHook still walks it and
        # halts the build on the libc it cannot find. Reproduced on
        # @yuuang/ffi-rs-linux-x64-musl under pi-pretty.
        autoPatchelfIgnoreMissingDeps = [
          "libc.musl-x86_64.so.1"
          "libc.musl-aarch64.so.1"
        ];

        bunDeps = bun2nix.fetchBunDeps { bunNix = import bunNix; };

        # Matches the flags the update app generated the lockfile with. A
        # divergence here makes --frozen-lockfile reject the vendored lock.
        bunInstallFlags = [
          "--linker=hoisted"
          "--frozen-lockfile"
          "--omit=dev"
          "--omit=peer"
        ];

        # These packages' install scripts are build tooling (napi, node-gyp) we
        # never want to run; the prebuilt platform packages are already in the
        # dep set.
        dontRunLifecycleScripts = true;

        # The normalisation must happen before bun2nix's hook runs its install,
        # and must be byte-identical to what the update app did.
        postPatch = ''
          ${normalisePackageJson}
          cp ${bunLock} bun.lock
          ${patchPhaseExtra}
        '';

        # These are source packages, not build products: pi loads the .ts files
        # through jiti at runtime, and pi-pretty ships tsc output already.
        dontBuild = true;
        # Stripping a prebuilt .node gains nothing and risks breaking it.
        dontStrip = true;

        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -R . $out/
          runHook postInstall
        '';

        meta = {
          description = "pi extension ${pname}";
          homepage = "https://www.npmjs.com/package/${pname}";
        }
        // meta;
      };

  prefix = map (p: "${drv}/${p}");
in
drv
// {
  passthru = (drv.passthru or { }) // {
    piEntrypoint = if entrypoints == [ ] then [ "${drv}" ] else prefix entrypoints;
    piSkills = prefix skills;
    piPrompts = prefix prompts;
    inherit
      settings
      configFiles
      promptFragment
      pname
      version
      bundled
      ;
  };
}
