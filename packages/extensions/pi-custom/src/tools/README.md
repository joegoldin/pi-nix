# tools: what the model can do beyond pi's built-ins

Entry: `index.ts`. Each tool keeps the name, parameters and result text of the
extension it replaces, so recorded sessions replay and the model's habits carry
over. Pure logic (formats, state, validation) sits in a `-state`, `-text` or
`-format` module beside each tool and is what the tests cover.

## Background tasks (`bg.ts`, `bg-format.ts`)

`bg_run` starts a named shell command in its own process group, logging to
`.pi/tasks/`. When it ends, a `<background-task-notification>` message tells the
model and starts a follow-up turn, so it never polls. `bg_status`, `bg_logs`
(bounded output) and `bg_kill` inspect and stop tasks; `/jobs`, `/logs <id>` and
`/kill <id>` do the same at the keyboard. Tasks live for the session.

Replaces pi-background-tasks. pi-subagents' `bg_wait` is separate: it waits for
async subagent runs only.

## Todo list (`todo.ts`, `todo-state.ts`)

The `todo` tool tracks tasks and optional top-level groups. Groups contain
one level of tasks, never other groups or grandchildren. `kind: "group"`
creates a group or converts an existing umbrella task; `parentId` attaches a
task, and `parentId: null` detaches it. Group progress is derived from live
children, with empty groups still pending. Counts include only tasks, not
groups. Dependencies (`blockedBy`) connect tasks independently of grouping.
Move or delete all live children before deleting a group; deletion never
silently cascades.

The list above the editor shows group counts and indented tasks. Click a
group header or use `/todos <group-id>` to collapse/expand it; groups start
expanded. Click a task to toggle wrapped text. Ctrl+Shift+T folds the whole
list; `/todos` displays the full list. Truncation preserves parent context
and prioritizes unfinished work. Completed tasks fade on the next turn.

Starting a task returns conflicting active tasks to pending. Simultaneous
work requires distinct explicit owners, not several unowned in-progress
rows. On settlement, including interruption, or session/branch restoration,
unfinished tasks return to pending; completion is never inferred. Descriptions
retain acceptance criteria, evidence, blockers and next actions. Running
background jobs retain their own lifecycle; record their IDs in the task
rather than using an idle agent's status as proof that work is running.

State travels in tool-result details; automatic idle resets append a
`pi-custom:todo-state` session entry. The latest branch-local snapshot wins
on replay and compaction. Older flat todo sessions remain readable.

Substantial multi-step work gets one independently verifiable outcome per
task without waiting to be asked. Useful umbrella goals become groups, not
extra active tasks. Small requests stay flat or need no list; explicit
opt-outs still apply. Tracking does not authorize extra scope, delegation,
publication, or an unsolicited design plan. Group completion alone is not
proof that a `/goal` is satisfied; final audits belong in explicit tasks.

Pi's custom system prompt omits tool `promptGuidelines`. Before each run,
the extension supplies only missing guidelines when the tool is active.
Goal kickoff, continuation and resume reinforce the same task/group semantics
and reconciliation of the existing list. Nesting and activity cleanup are
enforced by code; useful task decomposition remains model guidance.

Replaces rpiv-todo.

## Questions (`ask.ts`, `ask-state.ts`)

`ask_user_question` puts one to four structured questions to you: options with
descriptions, a free-text row, multi-select, notes, and a submit tab. RPC
clients get the same questions as dialogs; print and JSON modes, with no one to
answer, get an error the model can act on.

Replaces rpiv-ask-user-question.

## Goals (`goal.ts`, `goal-text.ts`)

`/goal [--tokens 100k] <objective>` runs one objective across as many turns as
it takes. A goal turn that ends without `goal_complete`, `goal_blocked` or
`goal_wait` is followed by a continuation prompt. It pauses for review after
`goalTurnLimit` automatic turns or `goalNoProgressTurns` identical tool-free
replies (both in `/ui`), or when the token budget runs out. Completion claims
are checked before they are accepted.

Goal guidance tells the model to address you directly, separate verified results
from remaining work, and put any action you need to take first. `goal_wait`
requires `waiting_for` (`user`, `background` or `external`), so its notice,
`/goal status` and footer distinguish waiting for you from waiting for a task or
event. Background and external waits explicitly say no action is needed from you.
Older saved waits without ownership keep their reason without guessing who must
act. Updates should name what happens next without promising an automatic resume
unless a notification or deadline is actually arranged.

A new run or turn consumes an active goal's previous wait, including background
notifications, extension messages, and queued delivery within the same run.
The old deadline is cancelled;
the run can establish a new wait or continue normally. Merely settling or
appending context does not wake a goal, and external activity does not reset
safety counters or reactivate paused goals.

Replaces pi-goal.

## Side questions (`btw.ts`)

`/btw <question>` asks a side model about the conversation so far (a snapshot of
its last 40k characters, no tools) without adding anything to it. Follow-ups
continue the thread; ctrl+r brings the latest exchange back into the editor as a
draft.

Replaces pi-btw.

## Run summary (`turn.ts`, `turn-text.ts`)

After a run of at least `turnSummaryMinSeconds` (5 by default, in `/ui`), a dim
line marks where it ended: `✻ Worked for 57s · done 11:11 AM · 1 shell still
running`, or `✗ Failed after 57s · …` when the run ended on an error. Interrupted runs get none. It is written once
pi settles, stays in the transcript, and is filtered out of every model request.
Claude Code's line after a turn, with its plain verb and not the rotating ones.
