{ jq }:
# Emitted into a shell script; both consumers `source`-substitute it verbatim.
#
# Two edits, both required, both discovered by running bun rather than reading
# docs:
#
#   1. Hoist every peer dependency that is neither `@earendil-works/*` nor
#      marked optional into `dependencies`. pi supplies its own packages to
#      extensions at runtime, so those peers must stay omitted; everything else
#      is a real runtime import. pi-background-tasks and @narumitw/pi-goal both
#      declare `typebox` as a plain peer and both `import` it, so under a bare
#      `--omit=peer` they install cleanly and throw on load.
#
#   2. Delete devDependencies outright. `bun install --lockfile-only --omit=dev`
#      writes the root dev entries into bun.lock without resolving them, and the
#      later `--frozen-lockfile` run then dies with
#      `Failed to resolve root dev dependency '@earendil-works/pi-coding-agent'`
#      (reproduced on pi-subagents).
#
# peerDependencies and peerDependenciesMeta are dropped after the hoist so bun
# does not re-resolve the @earendil-works tree transitively. That alone takes
# @juicesharp/rpiv-todo from 137 fetchurl entries to 2.
''
  ${jq}/bin/jq '
    (.peerDependenciesMeta // {}) as $meta
    | .dependencies = ((.dependencies // {}) + ((.peerDependencies // {})
        | with_entries(select(
            (.key | startswith("@earendil-works/") | not)
            and (($meta[.key].optional // false) | not)))))
    | del(.devDependencies, .peerDependencies, .peerDependenciesMeta)
  ' package.json > package.json.normalised
  mv package.json.normalised package.json
''
