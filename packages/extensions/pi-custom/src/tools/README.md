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

The `todo` tool creates, updates, lists and deletes tasks with status,
dependencies (`blockedBy`) and owners. The list is drawn above the editor
(ctrl+shift+t folds it) and `/todos` prints it. State travels in each todo
result, so it follows branches and compaction with nothing written to disk.

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

Replaces pi-goal.

## Side questions (`btw.ts`)

`/btw <question>` asks a side model about the conversation so far (a snapshot of
its last 40k characters, no tools) without adding anything to it. Follow-ups
continue the thread; ctrl+r brings the latest exchange back into the editor as a
draft.

Replaces pi-btw.
