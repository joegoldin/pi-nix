{
  pkgs,
  bun2nix,
}:

pkgs.writeShellApplication {
  name = "pi-sync-upstream";
  runtimeInputs = with pkgs; [
    bun
    coreutils
    gawk
    git
    gnugrep
    gnused
    jq
    nix
    nodejs
    npm-lockfile-fix
    prefetch-npm-deps
    bun2nix
  ];
  text = # bash
    ''
      set -euo pipefail

      tmpdir=$(mktemp -d)
      trap 'rm -rf "$tmpdir"' EXIT

      rev=$(git ls-remote --tags --refs https://github.com/earendil-works/pi.git 'v*' \
        | awk -F/ '{print $3}' \
        | grep -E '^v[0-9]+(\.[0-9]+)*$' \
        | sort -V \
        | tail -n1)
      [[ -n "$rev" ]]

      source=$(nix store prefetch-file --json --unpack \
        "https://github.com/earendil-works/pi/archive/refs/tags/$rev.tar.gz")
      hash=$(jq -r .hash <<< "$source")
      src=$(jq -r .storePath <<< "$source")

      cp -R "$src"/. "$tmpdir"
      chmod -R u+w "$tmpdir"
      npm-lockfile-fix "$tmpdir/package-lock.json"

      # workaround for vulnerable upstream lockfiles
      pushd "$tmpdir" >/dev/null
      npm audit fix --package-lock-only --ignore-scripts
      bun install --ignore-scripts
      bun2nix -o bun.nix
      popd >/dev/null

      # bun2nix emits `copyPathToStore ./packages/x` for each workspace member.
      # copyPathToStore reads the path AT EVALUATION TIME, and the path lives
      # inside the fetched pi source, so evaluating the module meant fetching
      # and unpacking pi's release tarball before nix could draw a single build
      # line. That is import-from-derivation, and on a cold eval cache it turned
      # `nixos-rebuild` into minutes of apparent hang.
      #
      # The rewrite hands each member to a function that returns a DERIVATION
      # instead. `''${src}/packages/x` inside a builder is a store-path reference,
      # which nix resolves when it schedules the build rather than while it is
      # still evaluating.
      sed -i '/^  fetchurl,$/a\  workspaceSubdir ? throw "coding-agent/bun.nix requires workspaceSubdir (see package-bun.nix)",' "$tmpdir/bun.nix"
      sed -Ei 's|copyPathToStore \.\/packages\/([^ );]+)|workspaceSubdir "packages/\1"|g' "$tmpdir/bun.nix"

      npm_deps_hash=$(prefetch-npm-deps "$tmpdir/package-lock.json" | tail -n1)

      jq \
        --arg rev "$rev" \
        --arg hash "$hash" \
        --arg npmDepsHash "$npm_deps_hash" \
        '.rev = $rev | .hash = $hash | .projects["coding-agent"].npmDepsHash = $npmDepsHash' \
        VERSION.json > "$tmpdir/VERSION.json"

      cp "$tmpdir/package-lock.json" package-lock.json
      cp "$tmpdir/bun.lock" bun.lock
      cp "$tmpdir/bun.nix" coding-agent/bun.nix
      cp "$tmpdir/VERSION.json" VERSION.json
      echo "Updated lockfiles and VERSION.json for $rev"
    '';
}
