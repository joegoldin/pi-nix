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

`intercom` keeps pi-intercom's name, actions and wording: `list`, `list-cwd`,
`send`, `ask` (blocks for the reply), `reply`, `pending`, `handover`, `cancel`,
`status`. `list` shows pi sessions and Claude Code sessions in separate
sections. A `to` is resolved by exact id, then by name across both lists, then
by id prefix; `pi:<name>` or `claude:<name>` picks one when both lists hold the
name, and a `uds:` address is always Claude's.

Claude Code peers take text only: attachments are inlined, and `cancel`,
`supersedes` and `retryOf` are refused. An `ask` to Claude resolves on the next
message from that session (Claude has no reply ids) and fails early if Claude
reports the message denied, refused, expired or dropped.

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

- `/intercom` (alt+m): pick a session and write it a message.
- `/handover [target] [next task]`: summarise this session with the current
  model, edit the summary, send it.
- `/intercom-id`: put a snippet addressing this session into the editor.

## pi-subagents

pi-subagents finds its intercom provider by convention, not by package, and
these are kept exactly: the `intercom` tool with `action: "ask"`; the
synchronous `intercom:session-identity` claim at session start, whose first
claim becomes the session id; `PI_INTERCOM_SESSION_ID`; the
`subagent-chat-<first 18 of the id>` name for unnamed sessions; relaying
`subagent:result-intercom` with an acknowledgement on
`subagent:result-intercom-delivery`, and `subagent:control-intercom`.
`contact_supervisor` and `subagent_supervisor` belong to pi-subagents and are
not registered here. Subagent children stay off Claude's list.

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
| `runtime.ts` | Lifecycle, both transports, inbox, tool actions, pi-subagents relays |
| `tool.ts` | The tool schema and dispatch |
| `peers.ts` | Rosters, target resolution, list text (pure) |
| `reply-tracker.ts` | Which asks are owed an answer (pure) |
| `handover.ts` | Handover summaries |
| `render.ts` | The message box |
| `config.ts` | The config file |
| `broker/` | pi↔pi transport |
| `claude/` | pi↔Claude Code transport |
