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

Tool results and completion notices use the shared custom cards and theme.
The dock shows one compact Jobs summary, clickable to reveal up to five task names and their outcomes. Ctrl+O shows all
jobs, including acknowledged history, and restores the local view when folded.
Acknowledged results disappear from the dock and Rex metadata, not history.
Automatic follow-up results remain working until consumed by the next turn. `/jobs` and `/logs <id>` open bordered views;
Up/Down, Page Up/Down and Home/End scroll, and Escape or Enter closes them.
Log views are bounded snapshots, not a live tail. Model-facing output and
completion delivery are unchanged.

Replaces pi-background-tasks.

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
`/goal status` and footer distinguish waiting for your action from waiting for a task or
event. Required manual steps take priority over an active background task: a test
waiting for you to click or drag is a user wait. For mixed waits, `reason` states
your exact action and how to report completion; `background_task` separately names
the running task, what it is doing or waiting for, and what happens next. Both
appear in the wait notice and `/goal status`, with abbreviated text in the footer. The UI adds only the heading,
never an automatic claim that no action is needed; the reason may say that only
when it is true.
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

## Side conversations (`btw.ts`)

`/btw <question>` forks the current saved conversation into an independent native
Pi session. `/btw new` starts blank; `/btw` or `/btw list` resumes a conversation.
Sessions, drafts and tool mode survive restarts. A fork made while a parent tool
is pending records that its result is unavailable; it never claims to have run it.

Use `/btw` or `/btw list` to select and continue a side conversation. Inside it:

- Enter sends a follow-up. Responses stream into the native overlay.
- Alt+s switches conversations; Alt+f forks the current side conversation;
  Alt+n starts blank.
- Escape or Ctrl+c returns to main **without stopping ongoing work**. Alt+x
  explicitly stops the side turn. Reopening cannot start a concurrent second turn.
- Alt+t chooses read-only or editing tools, when no turn is running. Read-only is
  the default and blocks write tools even if requested by name. Editing requires
  the parent's mandatory permission extension; child tools use native execution
  hooks and their own permission prompts, never direct calls to parent tools.
- Ctrl+r brings the latest exchange into the main editor; Ctrl+Shift+r brings
  the full side discussion, including visible errors and unanswered questions.
  These actions cancel a pending side turn, preserve the main draft, and never
  submit it. Ctrl+Shift+r requires distinct terminal reporting, such as Kitty keys.

The panel spans the full width of the top half of the space above the live main
input dock. Click either conversation or its input to focus it; Alt+b also
switches between main and side input without closing the panel. Both drafts
remain independent. Escape/Ctrl+c closes the panel instead. A second `/btw`
command is rejected while the panel is open; use its controls to switch threads.

The panel has a bounded viewport and a separate composer. Mouse wheel and
Page Up/Down scroll; Ctrl+Home/End jump to the beginning/latest messages. New
answers follow the tail unless you have scrolled up. The main editor and footer
remain full-width. Child status and editor writes cannot replace them.

Side transcripts stay in their own session files. The main session stores a
resume reference, not side messages. Side discussions do not enter the main model
context or minimap unless you explicitly bring them back. Main-conversation
Ctrl+c is unchanged.

Replaces pi-btw; the independent conversation workflow was inspired by
[pi-side-chat](https://github.com/nicobailon/pi-side-chat).

## Run summary (`turn.ts`, `turn-text.ts`)

After a run of at least `turnSummaryMinSeconds` (5 by default, in `/ui`), a dim
line marks where it ended: `✻ Worked for 57s · done 11:11 AM · 1 shell still
running`, or `✗ Failed after 57s · …` when the run ended on an error. Interrupted runs get none. It is written once
pi settles, stays in the transcript, and is filtered out of every model request.
Claude Code's line after a turn, with its plain verb and not the rotating ones.

Automatic `/goal` continuation prompts are collapsed in the native transcript by
default. The tool-output expansion toggle reveals the full prompt; collapsing
changes only its display, not the saved message or the instructions sent to the
model.
