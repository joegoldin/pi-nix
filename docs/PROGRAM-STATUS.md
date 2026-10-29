# Terminal program status

Pi reports OSC 7501 revision 0.4, the [Program Status Protocol supported by Rex](https://www.superlogical.com/rex/docs/build/program-status). This is terminal metadata, separate from Pi's footer, window title, notifications, and OSC 9;4 progress indicator.

## State ownership

The native `ProgramStatusReporter` owns the root record (`app=pi`). Extensions publish independent records through `ctx.ui.setProgramStatus(key, status)`, under `pi/<key>`. They never write competing root escape sequences.

| Activity | Report |
| --- | --- |
| Agent response, tool execution, compaction, retry delay | `working`, with a phase message |
| Active goal, including an arranged background or external wait between turns | `working`, without a fabricated percentage |
| Goal waiting for the user | `blocked`, `kind=question` |
| Goal safety/budget/usage review | `blocked`, `kind=question` |
| Goal completion | `done`; the footer's timeout does not clear it |
| Goal stopped at an unresolved blocker | `error` |
| Paused/cancelled work | `idle` |
| Background shell task | `working` → `done`, `error`, or `idle` on cancellation |
| Structured question | `blocked`, `kind=question`, cleared on answer, abort, or UI failure |
| Auto-mode or engine permission prompt | `blocked`, `kind=permission`, cleared on every exit path |
| Authentication | `blocked`, `kind=auth` → `done`, `error`, or `idle` |
| Todo tasks | `working` only with an active task; measured completed/live-task percentage; groups and tombstones excluded |
| Side conversation | Independent working/result record, even with its panel closed; child statuses are namespaced beneath it |
| Subagents/workflows/worker monitors | Bounded, hierarchical records from the provider's public status snapshot |

A real user blocker takes precedence over autonomous work. Otherwise active work keeps the root working after the model settles. Completed child records do not stop other workers. Source-specific clearing removes that source's descendants, not unrelated siblings. Session reset retires old records and blockers; live producers republish their state.

Subagent snapshots are requested only at startup and on lifecycle events, coalesced over 50 ms. Requests use the versioned, read-only `status` RPC, with bounded replies, cancellation on session replacement, and a two-second response deadline. There is no polling, spawning, remote provider probing, or inference. Worker attention does not imply a human blocker: a supervisor may resolve it autonomously. Unknown plugins must use the activity API; footer text is not parsed as a substitute for lifecycle information.

## Wire and lifecycle rules

- Supports all six states, hierarchical ids, `app`, `title`, `msg`, `kind`, and measured `progress`.
- Rejects invalid states and ids rather than accidentally addressing the root. Invalid optional values are omitted.
- Text is single-line, control-character sanitized, standard base64 UTF-8. Truncation respects code-point boundaries and the 2048-byte message / 192-byte title limits.
- Validates id length, segment length and depth; bounds cached records to 256, preserving the root and clearing evicted subtrees. Terminals may retain fewer records.
- Uses the existing query/DA handshake. Advertised state/kind lists are respected; absent lists use revision 0.4 defaults. Replies never become editor input. `PI_PROGRAM_STATUS=0` disables reporting; `1` skips detection.
- Complete reports replace prior metadata. The transport caches all records, including changes made before negotiation or while stopped, and replays them after restart.
- Stopping retires working/blocked records to idle, without globally clearing completed or failed results. A subsequent restart restores the cached active state.
- Pi's own main-screen OSC 133 prompt markers can retire active records in the terminal. They trigger event-driven replay, including split writes. Full resets replay all records. Fullscreen already strips transcript zone markers. There are no heartbeat reports.
- New extension reports use generic phases and explicit task labels, not commands, prompts, tool output, authentication errors, or side-conversation text. Native session names and existing native error summaries retain their upstream behavior.

## Verification

`checks.<system>.program-status` exercises the shipped formatter, transport, reporter, authentication, and dialog integration. It includes negotiated capabilities, limits, subtree clearing, reset/restart behavior, cancellation, background goal waits, and prompt-marker replay. The first-party extension checks cover real background processes, goal wait/wake/completion, question/permission cleanup, todo progress, side-session isolation, and subagent snapshot ownership. Existing native terminal tests cover the keyboard/DA negotiation boundary.

These checks capture emitted protocol bytes and native callbacks. They do not claim that a running Rex GUI has displayed the new states before the updated Pi package is activated. Rex owns presentation and notification policy.
