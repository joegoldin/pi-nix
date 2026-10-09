# ui: how a session looks

Entry: `index.ts`. Renderers and tools are registered when pi loads the
extension; anything needing a session, a terminal or the native index waits for
`session_start`, and only the terminal UI gets the editor, shimmer and
completer.

## Features

- **Tool cards.** Each tool call is drawn as one Claude Code-style card, a
  header naming the call with the result hanging off a `⎿` elbow, folded after a
  few rows behind `… +N lines (click or ctrl+o)`. An expanded card sits on a
  grey panel with its long lines wrapped; one that still hits the expanded-row
  cap says `… N more lines not shown (expanded view limit)`, so it never reads
  as folded. Built-in tools get cards written for them; others get a generic
  card; tools that ship their own renderer keep it. Modes: on, compact (header
  and result on one line), off (pi's own rendering). Cards honour Pi's `outputPad` setting, including
  grouped runs, and show the recorded `durationMs` as `Took …` on completed
  results; streaming results never show a final duration.
- **Tool runs.** Consecutive low-stakes exploration folds into one dim line,
  as Claude Code's does: reads, searches, listings, and shell commands that
  only inspect (`ls`, `cat`, `rg`, `git log`, `jj st`, `sed -n`, `gh pr view`
  and the like; `inspect.ts` has the list). A command that does anything else,
  or that the classifier cannot read (a file redirection, `$(…)`, an unknown
  program), keeps its card and ends the run, as edits, writes and tools with
  their own renderers do; so do prose, your message and the agent stopping.
  While the agent works, the run is one line in the present tense with the
  latest call under it, counting up in place:

  ```
  Thinking for 12s, running 3 shell commands, reading 1 file…
    ⎿  $ rg -n foo src
  ```

  When it closes the same line reads `Thought for 19s, ran 3 shell commands,
  read 1 file`. The thinking that led to the calls is part of the run: it
  streams where pi draws it while it is being written, folds into the run the
  moment its call joins one, and opening the run shows it, `∴ ` and dim, above
  the call it led to. Thinking before prose or a call drawn on its own stays
  where pi draws it, so no thinking shows twice. Thinking that is nothing but
  step titles (GPT-6's) is drawn as tight `∴ ` lines wherever it is. Clicking the line, open or
  closed (or ctrl+o, which opens every run), shows the cards on the panel under
  it; clicking it again folds them. A card you expanded keeps its run open. A
  failed call is never folded away: it shows on its own and the line counts it
  (`(1 failed)`). Thinking time is measured from pi's stream, so it only
  appears for runs seen live. "Group tool runs" in `/ui` turns this off.
- **Hover.** Under the mouse pointer, the grey text a click acts on brightens to
  the text colour: a card's `… +N lines` line, or a run's line. No background,
  as in Claude Code; a full-width grey panel means a card or run is open.
- **Diffs.** Edit and write results as unified or side-by-side diffs, switching
  on terminal width. A write over an existing file is diffed against what it
  replaced; a new file shows `Wrote N lines to <path>` and its opening lines,
  numbered and highlighted.
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
| `card.ts` | Card layout: header truncation, collapsing, wrapping, panel background, compact mode |
| `tools.ts` | What each tool's card says (pure) |
| `group.ts` | Runs of exploratory calls: the model built from the branch and the stream, the run line (pure) |
| `inspect.ts` | Which shell commands only inspect, and so may fold into a run (pure) |
| `hover.ts` | Which card the pointer is over, and noticing when it leaves (pure) |
| `render.ts` | Which calls get a card; joins pi's two render slots into one; folds rows into runs; mouse |
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

## Design notes

- **Colours.** The panel is the theme's `toolPendingBg`, the one background
  slot themes keep a neutral grey; the others are tinted for what they mean
  (selection blue, success green, error red). Hover uses the theme's `text`
  colour on text that is otherwise `muted` or `dim`. pi's system theme gives panels no
  background when the terminal reports no colours; the panel is then the
  theme's guess at the background mixed 22% toward the text.
- **Folding rows.** A folded row's card draws nothing, and pi drops a row that
  draws nothing, blank line and all. The run's line is drawn by its first row.
  pi puts a blank line above every row it does draw, so an open run's cards sit
  on the panel as separate blocks.
- **No flicker.** pi adds a tool row as soon as a call starts streaming in,
  before its arguments are complete, and half a shell command cannot be judged.
  While the agent works, such a row draws nothing until the call is known; it
  joins its run the moment its arguments end, or draws its card if it stands
  alone. A run's cards are never shown only to fold away: the live line stands
  for them from the first call.
- **What folds.** Folding hides a call, so only calls nobody needs to watch
  fold. The shell classifier errs toward a card: every program in a command
  must be a known reader used to read (`git branch` lists, `git branch -D`
  does not; `sed -n` reads, `sed -i` writes), and anything it cannot follow
  counts as doing something.
- **Thinking.** pi draws thinking inside its own assistant message, which an
  extension cannot reach, so pi is patched (`coding-agent/pi-patches.nix`) to
  ask a function on `globalThis[Symbol.for("pi-custom.hideThinking")]` which
  of a message's thinking blocks to leave out. pi-custom answers with the
  blocks that led to a call in a run, by content index, since one message can
  hold thinking for a run and thinking for a call drawn on its own. pi asks
  again on every paint, as the answer changes when a call joins a run. Rewriting the message to drop
  thinking was ruled out: the stored message is what the model is sent back,
  signatures and all.
- **Hover.** pi sends a move to the component under the pointer only, so a card
  knows when the pointer arrives but not when it leaves. Every pointer report
  either reaches a card, which claims it, or it does not, and then nothing is
  hovered. Seeing the reports takes a stdin listener of our own: in fullscreen,
  pi's viewport listener is registered in TuiAltScreen's constructor, ahead of
  any extension's `onTerminalInput`, and consumes every mouse report.
