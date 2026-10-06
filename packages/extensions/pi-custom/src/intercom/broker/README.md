# intercom/broker: the pi↔pi transport

One broker process per agent dir keeps the roster of running pi sessions and
routes messages between them over the Unix socket
`$PI_CODING_AGENT_DIR/intercom/broker.sock` (directory 0700, files 0600). The
first session that needs it starts it as `<brokerCommand> broker.ts`, detached;
it exits 5 s after the last session leaves. Sessions with different
`PI_INTERCOM_SCOPE_ID` values share the broker but cannot see each other.

Ported from pi-intercom 0.16.1
(MIT, Copyright (c) 2026 Nico Bailon; `LICENSE` here). The wire protocol is
unchanged ("pi-intercom" version 1), so this broker and client interoperate
with upstream's in either direction. The client keeps upstream's method and
event names.

| File | What it holds |
|---|---|
| `broker.ts` | The broker process: register, list, send (exact id, then name, then id prefix), ask edges, receipts, cancel and supersede, presence, the offline mailbox, the replay guard, rate and size limits, idle shutdown |
| `client.ts` | `IntercomClient`: connect and register, heartbeat, send with exact-send resolution, list, cancel, receipts, presence, disconnect |
| `spawn.ts` | Health probe, spawn lock, detached launch, startup errors with the broker's stderr (`broker.log`) |
| `protocol.ts` | Frame validators, the replay-guard fingerprint, `PI_INTERCOM_ASK_TIMEOUT_MS` |
| `framing.ts` | 4-byte length + JSON frames, capped at 1 MiB |
| `paths.ts` | Runtime paths and modes, scope id, the live-broker check, cwd comparison |
| `types.ts` | Wire types |

## Dropped from upstream

- **Windows named pipes and the TCP transport.** This setup is macOS and Linux.
- **The extension bus and outbox** (`extension_*` frames, owner election,
  persisted extension state, outbox provenance). Nothing here uses them. The
  broker does not advertise `extension-bus-v1`, answers `extension_*` frames
  with an `E_INVALID_MESSAGE` error, and refuses sends carrying `provenance`.
- **Cross-machine relays and Herdr locations.** Sends carrying `crossMachine`
  are refused; the client strips both fields from anything an upstream broker
  relays.
- **The tsx launch path.** Without `brokerCommand` the broker runs under pi's
  own runtime if that is bun or node, and otherwise spawning fails with an
  error naming the setting. Upstream fell back to whatever `node` was on PATH.
- **Pending-ask files** under `intercom/pending-asks/`. Nothing read them.

## Fixed

- **Live id takeover** (D2.2). A register claiming a live session's id gets
  "Session ID already held by a live session" and its socket closed; the
  incumbent keeps its id, epoch and mail. Upstream evicted the incumbent. This
  was pi-nix's patch to pi-intercom; it is now the code.
- **Stale ask edges** (D2.3). The asks a session made go when it disconnects
  or unregisters: its waiter went with it. Upstream kept them until the ask
  timed out, so an asker that came back under the same id was refused
  `E_MUTUAL_ASK`. Asks made *of* a session stay, so a target that drops and
  reconnects mid-ask can still answer the asker that is waiting.
- **Late socket errors** (D2.4). Every client and probe socket keeps a no-op
  `error` listener for life, and the client emits `error` only when someone
  listens, so an `ECONNRESET` after cleanup cannot crash pi.

Tests: `bun test src/intercom/broker`. `broker.test.ts` runs the real broker.
