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

      # bun2nix supports lockfile version 1; Bun preserves it when updating.
      cp bun.lock "$tmpdir/bun.lock"

      # workaround for vulnerable upstream lockfiles
      pushd "$tmpdir" >/dev/null
      bash ${./patches/vitest-ghsa-82fw-gwwq-j7x9.sh}
      npm dedupe --package-lock-only --ignore-scripts
      npm audit fix --package-lock-only --ignore-scripts
      bun install --ignore-scripts
      bun2nix -o bun.nix
      popd >/dev/null

      sed -i '/^  fetchurl,$/a\  workspaceRoot ? throw "coding-agent/bun.nix requires workspaceRoot (the upstream pi source root)",' "$tmpdir/bun.nix"
      sed -Ei 's|copyPathToStore \.\/packages\/([^ );]+)|copyPathToStore (workspaceRoot + "/packages/\1")|g' "$tmpdir/bun.nix"

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
