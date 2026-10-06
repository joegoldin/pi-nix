# Attribution

pi-custom is written for this repository. Its features are modelled on the
projects below, and it was designed by reading their code. Each is credited for
what it contributed. One part is a port rather than a reimplementation: the
intercom broker, adapted from pi-intercom, whose licence is kept in
[`src/intercom/broker/LICENSE`](src/intercom/broker/LICENSE).

## pi-cc-extensions

[minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)
(read at **v0.9.10**), Copyright (c) 2026 minuque, licensed under the MIT
License.

The feature set and its behaviour come from this project:

- Claude Code-style tool cards: a `●` header with a `⎿` result, expand and
  collapse, `on` / `compact` / `off` modes, and edit and write diffs
- The settings panel (here `/ui`, there `/ccstyle`)
- `/context`: the context-window breakdown and per-category previews
- `@` references to earlier sessions and to subagents
- Markdown touches: GitHub callouts and bare URLs turned into links

pi-custom reimplements these on pi's public extension API (`registerToolRenderer`,
`registerMarkdownTransformer`, `addAutocompleteProvider`) instead of patching
pi's components, and leaves out the parts that do not fit this setup:
fullscreen mode, the status bar, the bundled themes, and Mermaid dialects.

## pi-pretty

[heyhuynhgiabuu/pi-pretty](https://github.com/heyhuynhgiabuu/pi-pretty)
(read at **v0.6.30**), Copyright (c) 2025 huynhgiabuu, licensed under the MIT
License.

pi-custom replaces pi-pretty in this setup and carries its features over:

- The `❯` before user messages, and the rounded prompt box with the icon in
  its left padding
- The shimmer sweep across the working indicator
- Syntax-highlighted `read` with line numbers, `bash` exit summaries, and
  `ls` / `find` / `grep` results with Nerd Font file icons
- `find`, `grep` and `@` file completion through FFF, including the rewrite of
  bare `find` globs to the recursive form fd implies, and the fall back to
  pi's own tools when FFF has no answer

pi-pretty credits the shimmer and session accents to
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).

## pi

[earendil-works/pi](https://github.com/earendil-works/pi), licensed under the
MIT License.

pi-custom builds on pi's exported helpers (`highlightCode`, `getLanguageFromPath`,
`keyHint`, `truncateHead`, the built-in `find` and `grep` tool definitions) and
follows its `built-in-tool-renderer.ts` and `working-indicator.ts` examples.
Its `find` and `grep` output reproduces pi's formats and notices exactly.

## Agent tools

`src/tools/` reimplements five extensions so their tools keep the names,
parameters, descriptions and result text the model and recorded sessions
know. The wording of those model-facing strings is theirs.

- [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks)
  (read at **v2.6.9**), licensed under the ISC License: `bg_run`,
  `bg_status`, `bg_logs`, `bg_kill`, and the completion notification, as it
  behaved with `PI_BG_FEATURES=process`.
- [rpiv-todo](https://github.com/juicesharp/rpiv-mono) (read at **v2.12.0**),
  licensed under the MIT License: the `todo` tool, its status machine and
  replay from tool results, the list above the editor, and `/todos`.
- [rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono) (read at
  **v2.12.0**), licensed under the MIT License: `ask_user_question`, its
  validation, questionnaire and answer text.
- [pi-goal](https://github.com/narumiruna/pi-extensions) (read at
  **v0.54.8**), licensed under the MIT License: `/goal`, the goal contract and
  prompts, `goal_complete`, `goal_blocked`, `goal_wait`, and the continuation
  loop with its safety pauses.
- [pi-btw](https://github.com/narumiruna/pi-extensions) (read at
  **v0.61.1**), licensed under the MIT License: `/btw` side threads and the
  bring-back draft.

## Intercom

`src/intercom/` combines two extensions into one `intercom` tool and one inbox,
with pi sessions and Claude Code sessions as peers.

- [pi-intercom](https://github.com/nicobailon/pi-intercom) (read at
  **v0.16.1**, commit `a5fad4d`), Copyright (c) 2026 Nico Bailon, licensed
  under the MIT License. `src/intercom/broker/` is adapted from its broker,
  client, framing, paths and spawn code; the copyright and licence notice are
  kept in [`src/intercom/broker/LICENSE`](src/intercom/broker/LICENSE). The
  `intercom` tool's name, parameters, descriptions and result text, the
  inbox's trigger and hold rules, reply tracking, the handover prompt, and
  the event contract pi-subagents relies on follow pi-intercom; the rest of
  the extension is reimplemented. Left out: the cross-machine relay, Herdr
  panes, the CLI and the extension bus. Fixed: a live session ID can't be
  taken over (carried from pi-nix's patch), ask edges are cleared when a
  session leaves, a late socket error can't crash pi, a busy non-interactive
  session no longer answers asks with a canned reply, and a malformed config
  disables intercom instead of failing the extension.
- [pi-claude-link](https://github.com/alonw0/pi-claude-link) (read at
  **v0.1.0**, commit `7fdccbd`), Copyright (c) 2026 alonw0, licensed under the
  MIT License. The idea and approach of joining Claude Code's own peer
  messaging, so pi appears in its ListAgents and can use SendMessage, come
  from here, as does the close-on-half-close lesson. `src/intercom/claude/` is
  written from the protocol as Claude Code implements it rather than from
  pi-claude-link's protocol file, and fixes the issues listed in
  [`src/intercom/claude/README.md`](src/intercom/claude/README.md):
  no delivery receipts (pi-claude-link#2), a permission mode asserted to the
  receiver, receipts from Claude surfaced instead of dropped, explicit replies
  instead of relaying the last assistant text, and registry entries Claude can
  verify and clean up.

Claude Code's peer protocol belongs to Anthropic; pi-custom implements it for
interoperability and copies none of Claude Code's code.

## Runtime dependency

[@ff-labs/fff-bun](https://github.com/dmtrKovalenko/fff), licensed under the
MIT License, provides the file index behind `find`, `grep` and `@` completion.
