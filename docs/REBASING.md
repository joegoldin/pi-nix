# Rebasing on upstream

This repo is a fork of [lukasl-dev/pi.nix](https://github.com/lukasl-dev/pi.nix),
kept deliberately additive so upstream can be replayed underneath our changes.

## What is ours

Everything below is new; upstream has no file at these paths, so a rebase never
touches them:

- `lib/` — `mkPiSkill`, `mkPiPromptTemplate`, `mkPiPlugin`
- `packages/extensions/` — `mkPiExtension`, `normalise-package-json.nix`, and
  one `bun.lock` plus one generated `bun.nix` per unbundled pin
- `extensions.json` — the extension pin file
- `coding-agent/extra-options.nix` — `systemPrompt`, `extensionPackages`,
  `statusline`, `notifications`
- `tests/`, `update-extensions.nix`, `docs/REBASING.md`, `garnix.yaml`

## What we edit upstream

Prefer these insertion points; recorded protected-file exceptions are described below:

| File | Our change |
| --- | --- |
| `flake.nix` | `agent-statusline` input, `checks` output, `packages.ext-*`, `lib.builders`, `apps.update-extensions`, the `bun2nix` overlay on the `apps` block's nixpkgs, description |
| `update.nix` | takes `updateExtensions`, runs `pi-update-extensions` last |
| `coding-agent/lib.nix` | one line adding `extra-options.nix` to `modules` |
| `coding-agent/module.nix` | one line adding `extra-options.nix` to `imports` |
| `coding-agent/home-manager.nix` | one line adding `extra-options.nix` to `imports` |
| `README.md` | rewritten for the fork |

Prefer leaving `coding-agent/options.nix` unchanged. Its recorded fork changes
provide launcher configuration/MCP merging and private agent-directory mounts.
Our options module otherwise reaches pi's command line through `extraArgs`, `extensions`, `skills`,
`promptTemplates`, `settings`, and `environment`, all of which merge across
module definitions, and it overrides the `package` default with `lib.mkDefault`
rather than editing the declaration.

`packages.default` stays upstream's `coding-agent`, because changing it would
be a rewrite rather than an insertion. The *module* default is the Bun build;
`nix run github:joegoldin/pi-nix` still gives you the npm one. Use
`nix run .#coding-agent-bun` to run the same binary the modules install.

## Procedure

```bash
git fetch upstream
git rebase upstream/master
```

Expect conflicts in the table above and in the recorded protected-file divergences. Resolve by keeping
**both** sides: upstream's version of the surrounding code plus our insertion.
Never resolve a conflict by dropping an upstream hunk.

Then prove the fork is still additive and still works:

```bash
nix fmt
nix flake check -L
git diff upstream/master --stat -- \
  coding-agent/options.nix coding-agent/package.nix coding-agent/package-bun.nix \
  coding-agent/bun.nix sync.nix regenerate-models.nix scan.nix \
  VERSION.json package-lock.json bun.lock ai
```

Review any differences against the intentional divergences documented in
`tests/additive-test.nix`. A Pi runtime upgrade also changes the source pin,
generated locks and, when needed, dependency compatibility hooks. Review those
changes and refresh the protected-file hashes with the upgrade; do not remove
files from the guard or bypass it. Unexplained differences need investigation
before release.
