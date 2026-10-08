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
   a classifier block asks you first, with a countdown and a notification;
   no answer in time keeps the block, and the agent is told nobody answered,
   so a later go-ahead from you clears it.
4. **You**, at the permission prompt, for whatever the chain defers.

Only rules listed under `hard_deny` bind the classifier unconditionally; it is
told so, and its examples take their tier from the listed rules.

Esc with messages queued (pi-custom's steer) interrupts a check without
recording a denial: the call does not run, and it is logged and counted as
interrupted.

## Subagents

pi-subagents loads the permission system in a child from
`npm/node_modules/@gotgenes/pi-permission-system`, which pi-nix links to this
package, so a child gets both halves; a child's asks are forwarded to the
parent session. The package registers once per session even when a child is
handed it twice, by that link and by `settings.json`'s packages list.

## Config

pi-nix's `programs.pi.coding-agent.autoMode` options write both halves'
config: auto mode's rules as `PI_AUTOMODE_SETTINGS_JSON`, and the permission
system's as `extensions/pi-permission-system/config.json` in pi's agent
directory, where it has always read them. `autoMode.askOnBlock` turns on
asking before a classifier block stands.

## Commands

- `/automode`: auto mode's status, rules, recent denials and classifier model.
- `/permission-system`: the permission system's settings.

## Files

| Path | What it is |
|---|---|
| `src/index.ts` | The entry: both halves, auto mode first, once per session |
| `src/auto/` | pi-automode v1.17.0 `extensions/auto-mode/`, its entry as `index.ts` ([`LICENSE.md`](src/auto/LICENSE.md)) |
| `src/engine/` | pi-permission-system v40.0.1 `src/`, `#src/` imports made relative ([`LICENSE`](src/engine/LICENSE)) |
| `src/chain.test.ts` | The two joined: the chain link, the deterministic pre-pass, interrupt, ask-on-block, search redaction |
| `skills/automode-diagnostics/` | Auto mode's diagnostics skill, reading `docs/auto/` |

Changes to the vendored files carry a comment naming pi-permissions or pi-nix
where they are made. The two engines' own test suites run unmodified, except
where a marked assertion records one of those changes, in pi-nix's
`tests/permissions-upstream/`.
