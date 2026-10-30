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
The dock has a compact task icon. `/jobs` and `/logs <id>` open bordered views;
Up/Down, Page Up/Down and Home/End scroll, and Escape or Enter closes them.
Log views are bounded snapshots, not a live tail. Model-facing output and
completion delivery are unchanged.

Replaces pi-background-tasks. pi-subagents' `bg_wait` is separate: it waits for
async subagent runs only.

## Todo list (`todo.ts`, `todo-state.ts`)

`/todo <task>` sends the agent a steering message to add that task to the current
batch without replacing the existing work. It does not interrupt a running tool
or edit the list behind the agent's back. When idle, it starts a new turn. Bare
`/todo` shows the list, like `/todos`; `/todos <group-id>` keeps its group controls.

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
list; `/todos` displays the full list. Completed roots and children sort last
within their respective lists, including when expanded. A compact list that
needs truncation omits completed rows before budgeting unfinished work; small
lists can show both. Group counts always include completed children.

Completed rows fade at the next agent run or after 60 seconds, whichever comes
first. A single deadline timer handles long-running and idle sessions without
model calls. Reading the list or compacting the session does not renew the
countdown; clearing, changing branches and shutdown cancel stale deadlines.
This only hides rows: completed records, dependencies and evidence remain intact.
Expanded views and `/todos` still expose completed history.

A separate in-process background task asks the model to prune obsolete completed
records when at least five are complete and they make up half the list, or ten
are complete regardless of the ratio. After a one-minute delay it queues a
quiet follow-up message—not steering, a shell process, or a separate model call.
It never starts an idle agent. Only one reminder may be pending; another can be
sent after the previous message reaches conversation history and at least ten
minutes have passed. Reads and compaction do not reset its deadline. Clear,
branch changes and shutdown cancel pending timers.

The reminder tells the model to review the current list before tombstoning
obsolete completed tasks, preserving unfinished work, blockers, dependency
references and required evidence. The background task never deletes tasks itself;
if every completion is still referenced, it sends no reminder. At request time,
maintenance receipts are removed from conversational messages so they cannot
become a new user request. An eligible reminder becomes one bounded system hint,
reconstructed from the live list rather than its raw text. Stale reminders are
omitted. Cleanup is quiet bookkeeping: continue already-authorized work afterward,
not a cleanup-only final response. This never restarts completed, blocked or
waiting work, and the original receipt remains in session history for auditing.

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

Side conversations appear in the existing Down-arrow fleet menu. Select one and
press Enter to open or continue it. Inside a side conversation:

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

The overlay has a bounded viewport and a separate composer. Mouse wheel and
Page Up/Down scroll; Ctrl+Home/End jump to the beginning/latest messages. New
answers follow the tail unless you have scrolled up. The main editor and footer
remain full-width. Child status and editor writes cannot replace them.

Side transcripts stay in their own session files. The main session stores a
resume reference, not side messages; the fleet receives only identity/activity
metadata. Side discussions do not enter the main model context or minimap unless
you explicitly bring them back. Main-conversation Ctrl+c is unchanged; Ctrl+c in
the fleet, including its steering forms, returns to main without stopping a child.

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
