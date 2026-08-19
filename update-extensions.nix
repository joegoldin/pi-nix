{ pkgs }:

let
  # The identical string mkPiExtension runs in postPatch. Sharing it is not
  # tidiness: bun install --frozen-lockfile compares the lockfile against the
  # manifest, so a generator that normalises differently from the builder
  # produces a lockfile the builder rejects.
  normalisePackageJson = pkgs.callPackage ./packages/extensions/normalise-package-json.nix { };
in
pkgs.writeShellApplication {
  name = "pi-update-extensions";
  runtimeInputs = with pkgs; [
    bun
    bun2nix
    cacert
    coreutils
    curl
    gnused
    gnutar
    gzip
    jq
  ];
  text = # bash
    ''
      set -euo pipefail

      tmpdir=$(mktemp -d)
      trap 'rm -rf "$tmpdir"' EXIT
      export HOME="$tmpdir/home"
      mkdir -p "$HOME"

      cp extensions.json "$tmpdir/extensions.json"

      for name in $(jq -r 'keys[]' extensions.json); do
        slug=$(printf '%s' "$name" | sed -e 's|^@||' -e 's|/|-|g')
        enc=$(jq -rn --arg n "$name" '$n | @uri')

        meta=$(curl -fsSL "https://registry.npmjs.org/$enc")
        version=$(jq -r '."dist-tags".latest' <<< "$meta")
        vjson=$(jq -r --arg v "$version" '.versions[$v]' <<< "$meta")

        url=$(jq -r '.dist.tarball' <<< "$vjson")
        # npm publishes dist.integrity as an SRI string, which Nix accepts
        # verbatim. No prefetch needed, and no chance of a sha256/sha512 mixup.
        # bun2nix writes the same string into the fetchurl for every dependency
        # below, so one convention covers both layers.
        hash=$(jq -r '.dist.integrity' <<< "$vjson")

        # Skill and prompt directories come straight from the package's own pi
        # manifest, with the leading "./" stripped so they compose as
        # "''${drv}/''${path}".
        skills=$(jq -c '[.pi.skills[]? | sub("^\\./"; "")]' <<< "$vjson")
        prompts=$(jq -c '[.pi.prompts[]? | sub("^\\./"; "")]' <<< "$vjson")

        bundled=$(jq -r --arg n "$name" '.[$n].bundled' extensions.json)

        if [[ "$bundled" != "true" ]]; then
          work="$tmpdir/$slug"
          mkdir -p "$work"
          curl -fsSL "$url" | tar -xzf - -C "$work" --strip-components=1

          (
            cd "$work"
            ${normalisePackageJson}

            # --omit flags must match mkPiExtension's bunInstallFlags exactly.
            # --os/--cpu force every platform variant of an optional native
            # dependency into the lockfile; the build then installs only the
            # host's. Without them a lockfile generated on Linux omits the
            # Darwin tarballs and the Darwin build of that pin fails.
            bun install --lockfile-only \
              --omit=dev --omit=peer \
              --os='*' --cpu='*' >/dev/null
          )

          mkdir -p "packages/extensions/$slug"
          cp "$work/bun.lock" "packages/extensions/$slug/bun.lock"
          bun2nix -l "$work/bun.lock" -o "packages/extensions/$slug/bun.nix"
        fi

        jq \
          --arg n "$name" \
          --arg v "$version" \
          --arg u "$url" \
          --arg h "$hash" \
          --argjson s "$skills" \
          --argjson p "$prompts" \
          '.[$n].version = $v
           | .[$n].url = $u
           | .[$n].hash = $h
           | .[$n].skills = $s
           | .[$n].prompts = $p' \
          "$tmpdir/extensions.json" > "$tmpdir/next.json"
        mv "$tmpdir/next.json" "$tmpdir/extensions.json"

        echo "pinned $name@$version"
      done

      cp "$tmpdir/extensions.json" extensions.json
      echo "Updated extension pins in extensions.json"
    '';
}
