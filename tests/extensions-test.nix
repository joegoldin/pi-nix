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
    "ext-gotgenes-pi-permission-system"
    "ext-heyhuynhgiabuu-pi-pretty"
    "ext-juicesharp-rpiv-ask-user-question"
    "ext-juicesharp-rpiv-todo"
    "ext-narumitw-pi-btw"
    "ext-narumitw-pi-goal"
    # First-party, from packages/extensions/<name>: no pin, no lockfile.
    "ext-pi-auto-mode"
    "ext-pi-background-tasks"
    "ext-pi-cache-optimizer"
    "ext-pi-mcp-adapter"
    "ext-pi-notify"
    "ext-pi-subagents"
  ];

  # A pin is complete when its tarball coordinates are real. There is no
  # dependency hash to check: bun2nix keeps those in the per-pin bun.nix, and
  # Step 6's guard proves every unbundled pin has one on disk.
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
    assert exts.ext-pi-mcp-adapter.passthru.piEntrypoint == [ "${exts.ext-pi-mcp-adapter}" ];
    assert exts.ext-pi-mcp-adapter.passthru.piSkills == [ "${exts.ext-pi-mcp-adapter}/skills" ];
    assert exts.ext-pi-subagents.passthru.piPrompts == [ "${exts.ext-pi-subagents}/prompts" ];
    assert exts.ext-pi-background-tasks.passthru.piSkills == [ ];
    assert exts.ext-pi-mcp-adapter.passthru.settings == { };
    assert exts.ext-pi-mcp-adapter.passthru.promptFragment == null;
    # A first-party extension names its entrypoint explicitly instead, because
    # nothing about it is resolved from an npm manifest.
    assert exts.ext-pi-auto-mode.passthru.piEntrypoint == [ "${exts.ext-pi-auto-mode}/src/index.ts" ];
    assert exts.ext-pi-auto-mode.passthru.settings == { };
    assert exts.ext-pi-auto-mode.passthru.promptFragment == null;
    # It carries no pin, so extensions.json must not have grown one.
    assert exts.ext-pi-notify.passthru.piEntrypoint == [ "${exts.ext-pi-notify}/src/index.ts" ];
    # Neither first-party extension carries a pin, so extensions.json must not
    # have grown one.
    assert !(pins ? pi-auto-mode);
    assert !(pins ? pi-notify);
    # Exactly one pin takes the bundled branch, and it is the one with no
    # runtime dependencies. If a future bump gives pi-cache-optimizer a
    # dependency, this fires before anything ships a broken node_modules.
    assert pins."pi-cache-optimizer".bundled;
    assert lib.all (n: !pins.${n}.bundled) (
      lib.filter (n: n != "pi-cache-optimizer") (builtins.attrNames pins)
    );
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

  check ${exts.ext-pi-mcp-adapter} deps
  check ${exts.ext-pi-subagents} deps
  check ${exts.ext-pi-background-tasks} deps
  check ${exts.ext-juicesharp-rpiv-ask-user-question} deps
  check ${exts.ext-narumitw-pi-goal} deps
  check ${exts.ext-juicesharp-rpiv-todo} deps
  check ${exts.ext-gotgenes-pi-permission-system} deps
  check ${exts.ext-narumitw-pi-btw} deps
  check ${exts.ext-heyhuynhgiabuu-pi-pretty} deps
  check ${exts.ext-pi-cache-optimizer} nodeps

  # Skills and prompts advertised through the passthru must be real directories.
  test -d ${exts.ext-pi-mcp-adapter}/skills
  test -d ${exts.ext-pi-subagents}/skills
  test -d ${exts.ext-pi-subagents}/prompts

  # The two peers that must survive the --omit=peer install. Absent these, both
  # extensions load and then throw on their first `import { Type } from
  # "typebox"`, which is a failure that only shows up at runtime.
  test -d ${exts.ext-pi-background-tasks}/node_modules/typebox
  test -d ${exts.ext-narumitw-pi-goal}/node_modules/typebox

  # pi-cache-optimizer has no dependencies at all; a node_modules here would
  # mean the bundled branch quietly grew a bun install.
  ! test -e ${exts.ext-pi-cache-optimizer}/node_modules

  touch $out
''
