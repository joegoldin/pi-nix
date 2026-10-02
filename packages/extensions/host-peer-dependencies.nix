{ jq }:
# Emitted into a shell script and run in an extension's output directory, after
# its node_modules is in place.
#
# pi supplies some packages to every extension itself and aliases their imports
# to its own copy (pi-coding-agent 1.0.0, `src/core/extensions/loader.ts`). Since
# 1.0.0 it also warns at startup about every extension whose package.json lists
# one of them under `dependencies`, which several pins do: pi-automode and
# pi-subagents declare `typebox` there, and normalise-package-json.nix hoists the
# `typebox` peer of others into it.
#
# The fix belongs in the shipped manifest, not the install. Dropping `typebox`
# before bun runs would leave transitive users such as @juicesharp/rpiv-config
# without it, and would change the manifest the vendored bun.lock was frozen
# against. So the installed copy stays for those, and the manifest moves each
# host-provided entry to `peerDependencies` with the `*` range pi asks for.
#
# The names mirror pi's HOST_PROVIDED_EXTENSION_PACKAGES in
# `src/core/resource-loader.ts`.
''
  ${jq}/bin/jq '
    [
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "@mariozechner/pi-agent-core",
      "@mariozechner/pi-ai",
      "@mariozechner/pi-coding-agent",
      "@mariozechner/pi-tui",
      "@sinclair/typebox",
      "typebox"
    ] as $host
    | [(.dependencies // {}) | keys[] | select(IN($host[]))] as $moved
    | if $moved == [] then .
      else
        .dependencies |= with_entries(select(.key | IN($moved[]) | not))
        | .peerDependencies = ((.peerDependencies // {}) + ($moved | map({ key: ., value: "*" }) | from_entries))
      end
  ' package.json > package.json.host-peers
  mv package.json.host-peers package.json
''
