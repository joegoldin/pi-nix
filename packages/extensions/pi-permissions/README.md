# pi-permissions

Permissions and auto mode for pi in one extension. Policy rules settle what
they can with no model call; what they leave to judgement goes to a classifier;
what the classifier would block can be put to you first.

It takes over from two npm packages this setup ran side by side,
`@gotgenes/pi-permission-system` and `@czottmann/pi-automode`, and from the
pi-nix patches that joined them. Both engines are vendored here as source
([ATTRIBUTION.md](ATTRIBUTION.md)), with those patches folded in.

## How a tool call is decided

Each tool call passes through, in order:

1. **Auto mode's deterministic checks** (`src/auto/`): `permissions.deny`,
   its hard-deny list (shell profiles, `authorized_keys`, cron and launch
   agents, TLS and auth weakening, destructive deletes of home or system
   paths, its own config) and `deniedPaths`. A recursive `grep` or `find`
   whose scope can reach a denied path runs, and what it finds there is
   withheld from its result.
2. **The permission system's rules** (`src/engine/`): per-tool, path,
   external-directory and shell rules, with the shell command parsed by
   tree-sitter to find the paths it touches. `allow` and `deny` settle the
   call; `ask` goes on.
3. **The authorizer chain**: auto mode's classifier is a link on it, so an
   `ask` reaches the classifier before it reaches you. With `askOnBlock` on,
   a classifier block asks you first, in the terminal UI only, with a
   countdown and a notification: Allow (`y`) runs the call, Deny (`n` or Esc)
   refuses it, and no answer in time keeps the block, the agent told nobody
   answered, so a later go-ahead from you clears it. A headless session
   (print, JSON, RPC, a subagent) never asks; the block stands at once.
4. **You**, at the permission prompt, for whatever the chain defers.

Whatever either half blocks is recorded with the call's full input. In
`/permissions` you can approve it afterwards: the exact call, tool and input
as written, is then allowed for the rest of the session past both halves,
hard denies included, and the agent is told, so it retries. A block's reason
tells the agent this when there is a terminal UI to open the menu in.

Only rules listed under `hard_deny` bind the classifier unconditionally; it is
told so, and its examples take their tier from the listed rules.

Esc with messages queued (pi-custom's steer) interrupts a check without
recording a denial: the call does not run, and it is logged and counted as
interrupted.

## Subagents

Every subagent is gated, and grandchildren after it. At each session start
pi-permissions registers itself in pi-subagents' registry of required child
extensions, for every runner: every child of the session loads it, no agent
default, override or empty extension list removes it, a child that cannot
load it fails to start rather than running ungated, and a child is refused on
a runner that cannot load it (a remote machine). A child registers itself for
its own children in turn. A child is headless, so it never asks: what auto
mode would block there is blocked.

pi-subagents also loads the permission system in a child from
`npm/node_modules/@gotgenes/pi-permission-system`, which pi-nix links to this
package, and a child's asks are forwarded to the parent session. The package
registers once per session however many times a child is handed it.

## Config

pi-nix's `programs.pi.coding-agent.autoMode` options write both halves'
config: auto mode's rules as `PI_AUTOMODE_SETTINGS_JSON`, and the permission
system's as `extensions/pi-permission-system/config.json` in pi's agent
directory, where it has always read them. `autoMode.askOnBlock` turns on
asking before a classifier block stands.

## Commands

`/permissions` is the one place for all of it, a menu in four tabs (Tab and
Shift+Tab, or ←/→, move between them; Esc closes):

- **Denied**: what was blocked, newest first, the selected one with its
  reason and input. `a` (or Enter) approves it and tells the agent, `x`
  dismisses it.
- **Allowed**: what you approved. `x` revokes.
- **Auto mode**: on or off for this session, the classifier model (opens a
  picker), the ask-before-block setting, this session's counts with a reset,
  reload, the decision log, and any config warnings.
- **Settings**: the permission system's switches (YOLO mode, the review log,
  debug logging, double-press to confirm—off by default) and its config file. pi-nix writes
  that file when pi starts, so a change here lasts until then.

`/permissions approve last` approves the newest block without the menu.
`/permissions auto` and `/permissions settings` open their respective tabs.
Subcommands remain available there, for example `/permissions auto status` and
`/permissions settings show`. The legacy `/automode`, `/auto-mode`, and
`/permission-system` commands are no longer registered.

When enabled, double confirmation applies to Enter and decision hotkeys in
the inline permission dialog; Escape still denies immediately. Auto-mode block
prompts and non-TUI selects remain single-confirmation surfaces.

The prompts and the menu are drawn as pi-custom draws its dialogs: framed, in
the editor's place, `❯` on the highlighted row.

## Files

| Path | What it is |
|---|---|
| `src/index.ts` | The entry: both halves, auto mode first, once per session; the ledger around their tool_call handlers; `/permissions` |
| `src/denials.ts` | What was blocked and what you approved, persisted in the session (pure) |
| `src/ui/block-prompt.ts`, `block-prompt-state.ts` | The ask before a classifier block stands, with its countdown |
| `src/ui/menu.ts`, `menu-state.ts` | The `/permissions` menu |
| `src/ui/frame.ts`, `call-label.ts` | The dialog frame and how a call is named, after pi-custom's |
| `src/auto/` | pi-automode v1.17.0 `extensions/auto-mode/`, its entry as `index.ts` ([`LICENSE.md`](src/auto/LICENSE.md)) |
| `src/engine/` | pi-permission-system v40.0.1 `src/`, `#src/` imports made relative ([`LICENSE`](src/engine/LICENSE)) |
| `src/chain.test.ts` | The two joined: the chain link, the deterministic pre-pass, interrupt, ask-on-block, search redaction |
| `skills/automode-diagnostics/` | Auto mode's diagnostics skill, reading `docs/auto/` |

Changes to the vendored files carry a comment naming pi-permissions or pi-nix
where they are made. The two engines' own test suites run unmodified, except
where a marked assertion records one of those changes, in pi-nix's
`tests/permissions-upstream/`.
