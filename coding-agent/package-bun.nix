{
  stdenv,
  lib,
  runCommand,
  bun2nix,
  bun,
  nodejs,
  callPackage,
  src,
  version,
}:
let
  bunInstallFlags =
    if stdenv.hostPlatform.isDarwin then
      [
        "--linker=hoisted"
        "--backend=copyfile"
        "--frozen-lockfile"
      ]
    else
      [
        "--linker=hoisted"
        "--frozen-lockfile"
      ];
  workspacePackages = stdenv.mkDerivation {
    pname = "pi-coding-agent-bun-workspace";
    inherit src version bunInstallFlags;

    nativeBuildInputs = [
      bun2nix.hook
      bun
      nodejs
    ];

    bunDeps = bun2nix.fetchBunDeps {
      bunNix =
        {
          copyPathToStore,
          fetchFromGitHub,
          fetchgit,
          fetchurl,
          ...
        }@args:
        import ./bun.nix (
          args
          // {
            # A DERIVATION per workspace member, not a path read during
            # evaluation. bun2nix emits `copyPathToStore ./packages/x`, and
            # copyPathToStore reads its argument while nix is still evaluating;
            # pointed at the fetched pi source that meant downloading and
            # unpacking pi's tarball before a single build line appeared, which
            # is import-from-derivation and cost minutes on a cold eval cache.
            #
            # `${src}/${sub}` inside a builder is a store-path reference instead,
            # resolved when the build is scheduled. Evaluation never touches it.
            workspaceSubdir =
              sub:
              runCommand "pi-workspace-${lib.replaceStrings [ "/" ] [ "-" ] sub}" { } ''
                cp -R ${src}/${sub} "$out"
              '';
          }
        );
    };

    dontRunLifecycleScripts = true;

    postPatch = ''
      cp ${../bun.lock} bun.lock
    '';

    preBuild = ''
          find packages -name "package.json" -exec sed -i \
            -e 's/--watch --preserveWatchOutput//g' \
            {} \;

          for f in packages/ai/src/models.ts packages/agent/src/agent.ts packages/tui/src/utils.ts; do
            [ -f "$f" ] && echo '// @ts-nocheck' | cat - "$f" > tmp && mv tmp "$f"
          done

          changelogReplacement='`https://github.com/earendil-works/pi/blob/v${version}/packages/coding-agent/CHANGELOG.md`'
          for changelogUrl in \
            '"https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md"' \
            '"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md"'
          do
            if grep -qF "$changelogUrl" packages/coding-agent/src/modes/interactive/interactive-mode.ts; then
              substituteInPlace packages/coding-agent/src/modes/interactive/interactive-mode.ts \
                --replace-fail "$changelogUrl" "$changelogReplacement"
            fi
          done

          cp ${../ai/models.generated.ts} packages/ai/src/models.generated.ts
          cp -R ${../ai/providers}/. packages/ai/src/providers/

          substituteInPlace packages/ai/package.json \
            --replace-fail 'npm run generate-models && ' '''

          cat > patch-package-json.js <<'BUN'
      const fs = require('fs');
      for (const file of ['package.json', 'packages/ai/package.json', 'packages/coding-agent/package.json']) {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
          pkg.scripts[name] = script.replaceAll('npm run ', 'bun run ');
        }
        // Follow the root build order without producing its Node-only bundle.
        if (file === 'packages/coding-agent/package.json' && pkg.scripts['build:unbundled']) {
          pkg.scripts.build = pkg.scripts['build:unbundled'];
          pkg.bin.pi = 'dist/cli.js';
          pkg.exports['./rpc-entry'].import = './dist/rpc-entry.js';
        }
        fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
      }
      BUN
          bun patch-package-json.js
          rm patch-package-json.js
    '';

    buildPhase = ''
      runHook preBuild
      bun run build:offline
      runHook postBuild
    '';

    doCheck = true;
    checkPhase = ''
      runHook preCheck
      bun test packages/tui/test/tui-alt-screen.test.ts packages/tui/test/jump-to-last-user.test.ts
      runHook postCheck
    '';

    installPhase = ''
      runHook preInstall
      ${builtins.readFile ./pack.sh}
      runHook postInstall
    '';

  };
in
callPackage ./runtime.nix {
  inherit workspacePackages version;
  pname = "pi-coding-agent-bun";
  runtime = bun;
  cli = "dist/cli.js";
}
