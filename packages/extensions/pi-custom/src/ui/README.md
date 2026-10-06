# ui: how a session looks

Entry: `index.ts`. Renderers and tools are registered when pi loads the
extension; anything needing a session, a terminal or the native index waits for
`session_start`, and only the terminal UI gets the editor, shimmer and
completer.

## Features

- **Tool cards.** Each tool call is drawn as one Claude Code-style card, a
  header naming the call with the result hanging off a `⎿` elbow, folded after a
  few rows (ctrl+o expands). Built-in tools get cards written for them; others
  get a generic card; tools that ship their own renderer keep it. Modes: on,
  compact (header and result on one line), off (pi's own rendering).
- **Diffs.** Edit and write results as unified or side-by-side diffs, switching
  on terminal width. A write over an existing file is diffed against what it
  replaced.
- **Markdown.** `> [!NOTE]`-style callouts and clickable bare URLs, leaving code
  untouched.
- **Prompt box and shimmer.** Rounded editor with a `❯` coloured by thinking
  level; a shimmer in a per-session accent colour replaces the spinner while
  the agent works.
- **`/ui`.** Every setting in one list, saved as you change it.
- **`/context`.** Where the context window is going: system prompt, tools,
  skills, messages, estimated and scaled to pi's own total.
- **References.** `@session:<id>` pulls an earlier session's gist (what was asked
  and concluded) into the turn as its own card; `@agent:<name>` names a
  pi-subagents agent. Both complete after `@`.
- **Search.** `find`, `grep` and `@` file completion through FFF's frecency
  index, so recently used files rank first. Anything FFF can't answer the way
  pi's tools would falls back to them, and paths auto mode denies (`.env` and
  friends) are withheld.

## Files

| File | Role |
|---|---|
| `index.ts` | Registration and session wiring |
| `card.ts` | Card layout: header truncation, collapsing, compact mode |
| `tools.ts` | What each tool's card says (pure) |
| `render.ts` | Which calls get a card; joins pi's two render slots into one |
| `diff.ts` | Unified and split diffs from pi's display diff |
| `icons.ts` | Nerd Font glyphs for paths |
| `markdown.ts` | Callouts and link transforms |
| `editor.ts` | Prompt box and shimmer |
| `frame.ts` | Bordered box for overlays |
| `config.ts` | `pi-custom.json`: defaults, coercion, load and save |
| `settings.ts` | `/ui` |
| `context.ts` | `/context` |
| `references.ts` | `@session:` digests and `@agent:` lookup |
| `complete.ts` | The `@` completer layered over pi's |
| `search.ts` | find/grep semantics over FFF, with fallbacks (pure) |
| `fff.ts` | The live FFF index, tools and file completion |
