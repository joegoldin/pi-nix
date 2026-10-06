# Claude Code peer transport

Makes a pi session a peer of Claude Code's cross-session messaging. The session shows up in Claude's ListAgents, Claude sessions can SendMessage to it, and pi can send to them. The module has no pi imports. The extension glue calls `ClaudeTransport.start`/`stop`/`setName`/`setStatus`/`setSession`/`send` and receives `onMessage`/`onReceipt`.

The protocol is private to Claude Code and versioned with it. This implementation follows what Claude Code 2.1.286 does on macOS, as seen from its files and behaviour, and was written independently of Claude's code.

## Protocol in brief

- **Registry.** `<config>/sessions/<pid>.json`, one per session, where `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`. Claude lists an entry whose `messagingSocketPath` accepts a connection, under `name || basename(cwd)`. When an entry carries `pidDomain`, Claude checks `procStart` (`ps -o lstart=` with `LC_ALL=C TZ=UTC`) against the pid. A mismatch hides the entry, and a dead pid gets the entry deleted.
- **Socket.** `<XDG_RUNTIME_DIR or /tmp>/cc-socks/<pid>.sock`, or `/tmp/cc-socks-<uid>/<pid>.sock` when the path would exceed 103 bytes. The directory is 0700 and the socket 0600. Claude sends receipts only to a reply address in its own socket directory (or a canonical default one), so ours goes next to a live Claude socket when there is one.
- **Addresses.** `uds:` + the socket path with every UTF-8 byte outside `[A-Za-z0-9:_/.-]` percent-encoded.
- **Auth.** `<config>/sessions/<pid>.<sha256(resolve(socket))>.key` (0600, `{peerToken, procStart?, pidDomain?}`). A sender that finds the target's key writes `{"type":"auth","token":…}` as the first line. Auth is optional on macOS and Linux and required only on Windows.
- **Framing.** One connection per message, NDJSON, lines up to 1 MiB. The sender writes, half-closes, and counts the send as done only when the socket fully closes (5 s timeout). The receiver ends its side when the sender's end arrives.
- **Frames.** `{msg_id, type:"user", priority:"next", from:<uds address>, session_id?, message:{role:"user", content:<envelope>}}`. A frame whose `session_id` is not the receiver's is dropped. `{type:"control", action:"peer_message_status", orig_msg_id, status, status_detail?, reason, drop_reason?}` is a receipt. Claude encodes "refused" as `expired` with `status_detail:"refused"`.
- **Envelope.** `<cross-session-message from="…" from-session="…" hop-chain="…" from-name="…" from-mode="bypass|prompting" from-plugin="…">\n<body>\n</cross-session-message>`. Every attribute is optional, but they must appear in that order. Claude parses strictly and requires the envelope to rebuild byte for byte. In the body, any `<` (or look-alike bracket) that starts something passing for the tag's closer is escaped to `<\`. A receiver in bypass mode holds messages that assert no mode, or a different one.

## Files

| File | Kind | What it does |
|---|---|---|
| `transport.ts` | I/O | `ClaudeTransport`: registration, listener, sender, guards, exit cleanup |
| `registry.ts` | I/O | Reads and writes registry entries and key files, `procStart`, pidDomain matching |
| `socket.ts` | I/O | Probe, directory vetting, stale-socket claim, NDJSON listener, half-close sender |
| `paths.ts` | pure | Config and socket locations, address encoding, key file names, `pi-<dir>` names |
| `envelope.ts` | pure | Envelope build/parse, body escaping, name sanitising |
| `frames.ts` | pure | Line buffer, auth line, user frame, reading inbound frames and receipts |
| `guard.ts` | pure | Per-sender rate limit, duplicate window, TTL map of sent messages |

Each pure module has a `*.test.ts`. `registry.test.ts` and `transport.test.ts` exercise the I/O against fake Claude listeners in a temp dir, so they never touch the real registry or a real Claude socket.

## Differences from pi-claude-link, and why

pi-claude-link (MIT, alonw0) showed that this works. This module fixes the problems found in its main branch (7fdccbd):

1. **No `delivered` receipt (issue #2).** Claude shows `delivered` as "released after approval" even for a message it never held, which costs the sender a confused turn. We send no receipts at all, because pi has no approval step that would make `held`/`denied`/`expired` true.
2. **Half-close.** The listener ends its side when the client half-closes (7fdccbd fixed this too). `transport.test.ts` keeps a Claude-style sender as a regression test.
3. **UTC `procStart`.** `ps` runs with `LC_ALL=C TZ=UTC`, so the string matches the one Claude compares. `pidDomain` is written only when a live Claude entry's `procStart` can be reproduced for its pid, which proves we see the same pids. That turns on Claude's dead-entry cleanup without risking a "recycled" hide.
4. **`from-mode` asserted.** It defaults to `prompting`, so a prompting Claude session accepts our messages rather than holding them. A bypass session still holds them, which is Claude's policy and shows up as a `held` receipt.
5. **Receipts consumed.** Inbound `peer_message_status` becomes an `onReceipt` event matched to the sent message by `orig_msg_id`, with refusals decoded.
6. **Status kept current.** `setStatus("idle"|"busy")` patches `status`, `statusUpdatedAt` and `updatedAt`.
7. **No auto-relay.** Nothing is sent on the caller's behalf. The glue replies explicitly with `send`.
8. **Inbound limits.** Each sender gets a bucket of 30 refilled at 0.5/s, and a repeated `msg_id` within 30 s is dropped, matching Claude's own guard. The message event says whether the sender authenticated with our key.
9. **Unauthenticated `rename` ignored**, along with `notify_when_idle` and the artifact actions. The name is the user's to set, via `setName`, and records `nameSource` `user`/`derived` (PR #1).
10. **Percent-encoded `from`.** A socket path containing `~`, a space or non-ASCII still yields an address Claude accepts.
11. **Openers and closers escaped,** including case variants, padding, look-alike brackets, slashes, letters and dashes, and hidden characters.
12. **Config and socket locations.** `CLAUDE_CONFIG_DIR` is honoured. The socket directory comes from a live Claude socket (verified by probe), not the first entry found. The default follows Claude's 103-byte and `/tmp/cc-socks-<uid>` rules. A directory owned by someone else, or writable by group or others, is refused. A stale socket is removed only when nothing answers on it.
13. **Session replacement.** `setSession` re-registers under the new pi session id after `/new` or `/resume`, and frames addressed to the old id are then dropped.
14. **Cleanup.** Entry, key and socket are removed on `stop()` and on process exit. A crash still leaves the entry behind, but with `pidDomain` set Claude deletes it once the pid is dead.
15. **No debug log in `/tmp`.** Diagnostics go to an optional `log` callback.
16. **Auth key published and used.** We write our own key file and send the target's token when it has one.
