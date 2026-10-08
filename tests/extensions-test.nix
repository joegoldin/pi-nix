# Two layers. The eval layer asserts the passthru contract and the argument
# handling of both bundled and unbundled modes without fetching anything; the
# build layer proves each real pin actually builds and lands a loadable
# entrypoint on disk.
{ pkgs, ... }:
let
  lib = pkgs.lib;
  exts = import ../packages/extensions { inherit pkgs lib; };
  pins = builtins.fromJSON (builtins.readFile ../extensions.json);

  mkPiExtension = pkgs.callPackage ../packages/extensions/mk-pi-extension.nix { };

  # A synthetic bundled pin. Never built — only its attributes are read — so
  # the fake hash costs nothing and the bundled branch stays under test on the
  # settings/promptFragment axes the real bundled pin does not exercise.
  synthetic = mkPiExtension {
    pname = "@acme/pi-thing";
    version = "9.9.9";
    url = "https://registry.npmjs.org/@acme/pi-thing/-/pi-thing-9.9.9.tgz";
    hash = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    bundled = true;
    entrypoints = [ "dist/index.js" ];
    skills = [ "skills" ];
    settings.acme.enabled = true;
    promptFragment = "Use the acme tool for acme things.";
  };

  expectedNames = [
    "ext-narumitw-pi-usage"
    # custom, foreign-skills, notify, permissions and voice are first-party,
    # from packages/extensions/<name>: no pin, and only custom and permissions
    # vendor a lockfile.
    # They are listed in sorted order with the rest rather than grouped,
    # because the assertion compares against `builtins.attrNames`, which sorts.
    "ext-pi-custom"
    "ext-pi-foreign-skills"
    "ext-pi-lens"
    "ext-pi-notify"
    "ext-pi-permissions"
    "ext-pi-subagents"
    "ext-pi-voice"
    "ext-pi-web-access"
  ];

  # A pin is complete when its tarball coordinates are real. There is no
  # dependency hash to check: bun2nix keeps those in the per-pin bun.nix, and
  # Step 6's guard proves every unbundled pin has one on disk.
  # Every pin carries npm's own dist.integrity, which is sha512.
  pinComplete =
    _name: pin:
    pin.version != ""
    && lib.hasPrefix "https://registry.npmjs.org/" pin.url
    && lib.hasPrefix "sha512-" pin.hash;

  evalAssertions =
    assert lib.sort (a: b: a < b) (builtins.attrNames exts) == expectedNames;
    assert synthetic.passthru.piEntrypoint == [ "${synthetic}/dist/index.js" ];
    assert synthetic.passthru.piSkills == [ "${synthetic}/skills" ];
    assert synthetic.passthru.piPrompts == [ ];
    assert synthetic.passthru.settings == { acme.enabled = true; };
    assert synthetic.passthru.promptFragment == "Use the acme tool for acme things.";
    # An empty entrypoints list means "hand pi the package root and let it read
    # the pi manifest", which is the normal path for every real pin.
    assert exts.ext-pi-subagents.passthru.piEntrypoint == [ "${exts.ext-pi-subagents}" ];
    assert exts.ext-pi-web-access.passthru.piPrompts == [ ];
    assert exts.ext-pi-subagents.passthru.piPrompts == [ "${exts.ext-pi-subagents}/prompts" ];
    assert exts.ext-pi-web-access.passthru.piSkills == [ ];
    assert exts.ext-pi-subagents.passthru.settings == { };
    assert exts.ext-pi-subagents.passthru.promptFragment == null;
    # A first-party extension names its entrypoint explicitly instead, because
    # nothing about it is resolved from an npm manifest.
    assert exts.ext-pi-notify.passthru.piEntrypoint == [ "${exts.ext-pi-notify}/src/index.ts" ];
    assert exts.ext-pi-voice.passthru.piEntrypoint == [ "${exts.ext-pi-voice}/src/index.ts" ];
    assert exts.ext-pi-voice.passthru.settings == { };
    assert exts.ext-pi-voice.passthru.promptFragment == null;
    # No first-party extension carries a pin, so extensions.json must not have
    # grown one.
    assert !(pins ? pi-notify);
    assert !(pins ? pi-voice);
    # Every pin installs runtime dependencies.
    assert lib.all (n: !pins.${n}.bundled) (builtins.attrNames pins);
    assert lib.all (n: pinComplete n pins.${n}) (builtins.attrNames pins);
    true;
in
assert evalAssertions;
pkgs.runCommand "pi-nix-extensions-tests" { nativeBuildInputs = [ pkgs.jq ]; } ''
  set -euo pipefail

  check() {
    local root="$1"
    local wantDeps="$2"
    test -f "$root/package.json"
    if [ "$wantDeps" = deps ]; then
      # Every unbundled pin publishes source against dependencies it does not
      # vendor, so node_modules must have been materialised at build time.
      test -d "$root/node_modules"
    fi
    # Each entry the pi manifest declares must actually exist, or pi silently
    # resolves zero entrypoints and the extension never loads.
    local n
    n=$(jq -r '[.pi.extensions[]?] | length' "$root/package.json")
    test "$n" -gt 0
    jq -r '.pi.extensions[]' "$root/package.json" | while read -r e; do
      test -e "$root/$e"
    done
  }

  check ${exts.ext-pi-subagents} deps
  check ${exts.ext-pi-permissions} deps

  # Skills and prompts advertised through the passthru must be real directories.
  test -d ${exts.ext-pi-subagents}/skills
  test -d ${exts.ext-pi-subagents}/prompts

  # pi-permissions' engines: auto mode's command analysis, and the permission
  # system's tree-sitter parser with the WASM grammars it loads at runtime.
  test -d ${exts.ext-pi-permissions}/node_modules/unbash
  test -f ${exts.ext-pi-permissions}/node_modules/web-tree-sitter/web-tree-sitter.wasm
  test -f ${exts.ext-pi-permissions}/node_modules/tree-sitter-bash/tree-sitter-bash.wasm

  touch $out
''
