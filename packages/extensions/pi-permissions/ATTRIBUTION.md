# Attribution

pi-permissions is one permission and auto-mode extension made from two. Their
engines are carried here as vendored source rather than reimplemented, each
with its licence beside it; the extension around them, joining the two into
one tool-call pipeline, its prompt and its menu are written for this
repository. Each engine's own test suite runs against the vendored copy in
pi-nix's `permissions-upstream` check.

## pi-permission-system

[gotgenes/pi-packages: pi-permission-system](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
(`@gotgenes/pi-permission-system`, vendored at **v40.0.1**, tag
`pi-permission-system-v40.0.1`, commit `b0e1f73`), Copyright (c) 2026 MasuRii
and Christopher D. Lasher, licensed under the MIT License. The notice is kept
in [`src/engine/LICENSE`](src/engine/LICENSE).

`src/engine/` is its `src/`, with the `#src/` import alias rewritten to
relative paths: the policy rules, the path and external-directory gates, the
tree-sitter shell access analysis, the authorizer chain, session grants,
subagent prompt forwarding and the review log.

## pi-automode

[czottmann/pi-automode](https://github.com/czottmann/pi-automode)
(`@czottmann/pi-automode`, vendored at **v1.17.0**, commit `820d7f2`),
Copyright (c) 2026 Carlo Zottmann, licensed under the MIT License. The notice
is kept in [`src/auto/LICENSE.md`](src/auto/LICENSE.md).

`src/auto/` is its `extensions/auto-mode/`, with its entry
(`extensions/auto-mode.ts`) as `index.ts`: the classifier and its transcript,
the deterministic hard-deny checks, permission patterns, denied paths and the
decision log.

## pi

[earendil-works/pi](https://github.com/earendil-works/pi), licensed under the
MIT License. The extension is written against pi's extension API, and both
engines use pi's exported helpers.

## Runtime dependencies

- [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) and
  [tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash) (MIT),
  for the permission engine's shell parsing.
- [zod](https://github.com/colinhacks/zod) (MIT), for its config validation.
- [unbash](https://github.com/webpro-nl/unbash) (ISC), for auto mode's
  command analysis.
