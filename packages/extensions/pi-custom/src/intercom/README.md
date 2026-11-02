# intercom: talking to other agent sessions on this machine

Entry: `index.ts`. One `intercom` tool and one inbox, with two kinds of peer:

- **pi sessions**, through a broker process on a Unix socket under
  `$PI_CODING_AGENT_DIR/intercom/` ([`broker/`](broker/README.md), ported from
  pi-intercom).
- **Claude Code sessions**, through Claude's own peer registry: this session
  appears in Claude's ListAgents, Claude's SendMessage reaches it, and the
  intercom tool reaches Claude sessions ([`claude/`](claude/README.md)).

Nothing is registered unless `intercom/config.json` exists; pi-nix's
`messaging` option writes it.

## The tool

`intercom` keeps pi-intercom's actions: `list`, `list-cwd`,
`send`, `ask` (blocks for the reply), `reply`, `pending`, `handover`, `cancel`,
`status`, and adds `complete` for cooperative peer completion. `list` shows pi sessions and Claude Code sessions in separate
sections. A `to` is resolved by exact id, then by name across both lists, then
by id prefix; `pi:<name>` or `claude:<name>` picks one when both lists hold the
name, and a `uds:` address is always Claude's.

Claude Code peers take text only: attachments are inlined, and `cancel`,
`supersedes` and `retryOf` are refused. An `ask` to Claude resolves on the next
message from that session (Claude has no reply ids) and fails early if Claude
reports the message denied, refused, expired or dropped.

## Completion and graceful exit

`intercom({ action: "complete", to, message, requestCleanup: true, quit: "ask" })`
reports a contribution and offers a graceful quit in this peer's local UI.
`quit` defaults to `keep`; `auto` requires the explicitly user-authorized,
one-shot `--peer-auto-exit` launch flag. Completion waits for transport delivery
and a clean, saved final reply before requesting native shutdown. New user or
custom messages, pending work, other tools, active `/goal`, `/btw` turns,
background tasks and unresolved peer asks prevent exit. A missing UI or declined
confirmation leaves it open.

The `pi-peer-completion-v1` context attachment carries the native Pi session ID,
quit policy and a cleanup request. It is a self-report, not an integration
verdict or user authorization. Neither this action nor graceful Pi shutdown
closes panes or worktrees; the requester needs user consent and fresh terminal
identity/occupant checks before terminal cleanup. The flag is registered only
when Intercom is enabled.

## The inbox

Every inbound message, from either transport, is de-duplicated, matched to a
waiting `ask`, recorded as answerable, then held or shown:

- **Trigger policy** (`inboundTrigger`, `replies` by default): a message starts
  a turn only if it answers something this session sent. For pi peers that is
  a `replyTo`; for Claude peers, coming from a session this one messaged in the
  last hour. Anything else is shown and waits for the next turn.
- **Holding**: during compaction, while a session with no one at the keyboard
  is busy, and under `busyDelivery: "human-first"`, messages wait and are
  delivered when it is safe.
- **Replies are explicit.** Nothing is ever sent on the model's behalf; it
  answers with `reply` or `send`.

Messages render as a rounded box headed by the sender (ctrl+o expands).

## Commands

- `/intercom` (alt+j): pick a session and write it a message.
- `/handover [target] [next task]`: summarise this session with the current
  model, edit the summary, send it.
- `/intercom-id`: put a snippet addressing this session into the editor.

## Session identity

Ordinary Pi peers use the native session header id by default, making terminal
session metadata match the Intercom roster. `PI_INTERCOM_SESSION_ID` exposes the
active Intercom id; an explicit `PI_INTERCOM_STABLE_ID` or `stableId` config can
still override it. Unnamed sessions appear as `pi-<first 18 id characters>`.
Names and abbreviated list ids are conveniences; the full roster id identifies
the session.

There is no child-plugin identity claim, result/control relay or supervisor
channel. A peer is an independent session, not a managed child. Each session owns
its permissions, and peer-authored messages remain untrusted input.

## Config

`$PI_CODING_AGENT_DIR/intercom/config.json`, read once at load:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | true (when the file exists) | Off without the file |
| `brokerCommand`, `brokerArgs` | this process's runtime, `[]` | How the broker is started |
| `inboundTrigger` | `replies` | `always`, `replies` or `never` |
| `busyDelivery` | `steer` | Or `human-first` |
| `confirmSend` | false | Ask before non-reply sends |
| `replyHint` | true | Show the reply call under asks |
| `status`, `stableId` | — | Status suffix; fixed id (avoid in a shared file) |
| `claude.enabled` | true | Join Claude Code's peer list |
| `claude.fromMode` | `prompting` | Mode asserted to Claude; a session in another mode holds our messages for approval |

A malformed file turns intercom off and says why once, instead of failing the
extension. `PI_INTERCOM_ASK_TIMEOUT_MS` sets how long an `ask` waits.

## Files

| File | Role |
|---|---|
| `index.ts` | Registration, commands, message renderer |
| `runtime.ts` | Lifecycle, both transports, inbox, tool actions |
| `completion.ts` | Completion reports and consented, idle-only graceful exit |
| `tool.ts` | The tool schema and dispatch |
| `peers.ts` | Rosters, target resolution, list text (pure) |
| `reply-tracker.ts` | Which asks are owed an answer (pure) |
| `handover.ts` | Handover summaries |
| `render.ts` | The message box |
| `config.ts` | The config file |
| `broker/` | pi↔pi transport |
| `claude/` | pi↔Claude Code transport |

On Pi 1.4, an idle wake uses the native custom-message turn lifecycle, not an
extra user prompt. Queued broker mail keeps the broker alive while all sessions
are disconnected, until delivery or the existing 24-hour expiry. Mail is still
in memory and does not survive a broker crash or reboot.
