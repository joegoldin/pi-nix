# pi-permissions

Permissions and auto mode for pi in one extension. Policy rules settle what
they can with no model call; what they leave to judgement goes to a classifier;
what the classifier would block can be put to you first.

It takes over from two npm packages this setup ran side by side,
`@gotgenes/pi-permission-system` and `@czottmann/pi-automode`, and from the
pi-nix patches that joined them. Both engines are vendored here as source
([ATTRIBUTION.md](ATTRIBUTION.md)), with those patches folded in.

Press **Ctrl+P** to open the same menu as `/permissions`. This does not submit
the editor draft or change any permission setting.

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
   a classifier block asks you first, in the terminal UI only, with a
   countdown and a notification. `y` approves the displayed reusable scope;
   `Y` approves just this attempt. Reusable approval is offered only for a
   soft denial with a supported scope. `n` or Esc refuses; no answer in time
   keeps the block. `e` stops the timer and shows the full reason, exact
   command and tool input without executing anything. ↑/↓ scroll; `e` or Esc
   returns, with the timer still stopped. A headless session
   (print, JSON, RPC, a subagent) never asks; the block stands at once.
4. **You**, at the permission prompt, for whatever the chain defers.

Whatever either half blocks is recorded with the call's full input. In
`/permissions` you can approve it afterwards. Shell approvals enter the same
bounded scenario ledger used by the classifier, without bypassing deterministic
restrictions. Non-shell approvals retain the exact-call session override; older
exact grants are unchanged. The agent is told so it can retry. A block's reason
tells the agent this when there is a terminal UI to open the menu in.

The automatic popup is the normal approval request. A timeout does not tell the
agent to ask you again: it should continue independent work. During an active
`/goal`, it should enter `goal_wait(waiting_for="user")` only when the approval
actually blocks the goal and no independent work remains. An explicit rejection
must not trigger another request without a new instruction.

For a separate review that is genuinely needed, the agent can call
`ask_for_approval({ denialId: "d1" })`, using the reference in the blocked result.
The dialog links to the recorded action, shows its original input and bounded
scope, and records your answer directly. There is no second permissions-menu
approval. It does not execute the action: a retry still passes policy and risk
checks. This tool offers scope approval, not an exact-call execution bypass.
Hard restrictions, classifier failures, explicit rejections, stale or changed
requests, and child-owned or historical denials without review metadata are not
eligible. Cancellation and timeout grant nothing; a denial cannot open repeated
linked questions. The existing menu remains available for direct user review.

A shell command can have effects beyond its parser-proven directory access.
For example, `cd worktree` proves traversal, not the effects of a following
Python heredoc. The displayed approval now includes both the command scope and
the directory scope, and stores both. A read-directory grant is never silently
promoted to write access.

Reusable approvals live in that same ledger and Allowed tab. For shell calls,
`y` approves similar `bash` or `bg_run` actions for the same task and targets:
its hosts, repositories, directories, services, recipients and side-effect types.
Arguments, implementation and diagnostic filenames may vary. The classifier
receives the displayed scope and complete original call when reviewing each
variant; sharing a command name or working directory is not enough. New targets,
additional side effects, greater risk or unclear bounds still need approval.
For edit/write calls, the scope remains that tool's operation on the same resolved
file path; contents may differ. Older saved shell grants retain their original
exact-command scope rather than silently gaining broader authority.

These call scopes expire on your next instruction or submitted questionnaire answer,
or when revoked. They resolve soft denials, not hard denials or classifier
failures, and never skip deterministic checks, explicit ask rules or
protected-write checks. Branches restore their own ledger. `Y` records no
reusable scope.

For an eligible soft denial, the classifier model makes one additional, bounded
call to recommend folder access. It chooses only native canonical targets: a
repository/worktree root or, for file tools, the narrower containing folder.
Capabilities are read, read/write, execute, or their combinations. A direct write
always requires a writable proposal, even before the external-directory gate.
Invalid, unavailable or timed-out suggestions fall back to native scope detection;
the model never grants access or chooses its lifetime.

When a bounded folder scope is available, the primary popup offers:

- **Allow for this session** (`y`, default).
- **Allow for this and future sessions** (`f`). Only folder permissions persist,
  and only for conversations started in the same canonical Pi launch folder.
  Starting in the target folder, a parent or a sibling does not inherit them.
- **Allow once** (`Y`), without a reusable grant.
- **Deny** (`n` or Esc). The same action is not asked again until a new operator
  instruction or explicit menu approval; extension continuations do not reset it.

The popup displays the folder, capabilities and future-session boundary before
approval. Future grants are stored under Pi's agent directory in
`permissions/directory-grants`, not in project-controlled configuration. They are
reloaded before checks, so revocation also reaches other running conversations.
The Allowed tab in `/permissions` revokes the selected session or saved grant.
Persistent grants are not offered for child-owned requests.

Conversation access survives ordinary messages, questionnaire answers and session
resume. Read-only access never covers a write, and execute-only access does not
supply file-read or write permission. Canonical file-tool checks exclude similarly
named siblings and symlink escapes. Saved records with changed canonical targets,
invalid data or unsafe file ownership/permissions grant nothing.

The native answer also settles that directory check; it does not open a second
permission dialog for the same access. A request-bound user receipt, or a matching
grant revalidated after model review, supplies that authority—not the model's
approval alone. Explicit path asks and denials remain separate.

Directory access is not an executable-call override. The classifier still reviews
actions, including destructive cleanup, discarded work, secrets, publishing,
deployment and external recipients; explicit policy and later restrictions still
apply. It no longer invents a file-by-file authorization checklist for ordinary
feature work. Parent conversation access is available to forwarded children;
a child-only grant remains bound to that child's session and cwd.

Questionnaires do not go through the classifier: asking for a decision does not
execute the proposed action. Explicit deny rules still apply. Successful answers
are recorded in the native session and read alongside real user messages in
chronological order, including across compaction. Older answers are recovered
only from matched questionnaire calls and validated results; arbitrary tool output
cannot supply approval. Later instructions can narrow or revoke earlier answers.

Native todo-maintenance reminders also reach the classifier, but only as bounded
bookkeeping context reconstructed from validated candidate IDs—not their raw text
and not operator authorization. Candidates still require a current status and
dependency check. Deleting a native todo tombstones it; it does not erase a session
transcript or audit log. Simple awaited `todo` list/get/delete calls and literal
`for (const id of [1,2])` batches have a bounded bookkeeping shortcut, with optional
`text(...)` output. Native codemode still routes every nested call through tool
validation and permission hooks. Dynamic code, `clear`, and wrappers mixing other
actions remain classified; explicit deny and ask rules still apply.

Requested inspection includes the bounded discovery needed to locate the named
records; an outside-cwd path or a Python wrapper does not turn a read into a write.
Secret, disclosure and explicit path restrictions still apply. Historical blocked
statuses are not user revocations: later authorization for iterative testing on
the same host/worktree and isolated app covers ordinary rebuilds and repeat tests,
not new targets, privacy changes or materially greater disruption.

Native supervisor requests/replies and local inter-agent messages also bypass
classification: they convey data, not permission to execute the actions described
in that data. Explicit deny and ask rules still apply. Native subagent status,
list and guide queries, and background status/log reads, use the read-only tier
unless `classifyReadOnlyTools` is enabled. These shortcuts accept only known
argument shapes; dispatch, steer, handover, mixed status/task inputs and arbitrary
code wrappers remain on the normal review path.

Only rules listed under `hard_deny` bind the classifier unconditionally; it is
told so, and its examples take their tier from the listed rules.

Esc with messages queued (pi-custom's steer) interrupts a check without
recording a denial: the call does not run, and it is logged and counted as
interrupted.

## Subagents

Every subagent is gated, and grandchildren after it. At each session start
pi-permissions registers itself in pi-subagents' registry of required child
extensions, for every runner: every child of the session loads it, no agent
default, override or empty extension list removes it, a child that cannot
load it fails to start rather than running ungated, and a child is refused on
a runner that cannot load it (a remote machine). A child registers itself for
its own children in turn. A child is headless, so it never asks: what auto
mode would block there is blocked.

pi-subagents also loads the permission system in a child from
`npm/node_modules/@gotgenes/pi-permission-system`, which pi-nix links to this
package, and a child's asks are forwarded to the parent session. The package
registers once per session however many times a child is handed it.

Forwarded requests carry the original tool name, call ID and complete arguments;
child call IDs never select an unrelated cached parent call. Denials appear in
the parent's menu with the child name and session ID, including denials resolved
by the serving node's policy. Incomplete legacy requests and explicit rule
denials are visible but cannot be approved out of those restrictions.

Child menu approvals remain bound to that child session and working directory.
They never authorize the parent or sibling workers. Exact child grants still
pass deterministic checks; scoped grants are reviewed with that child's own
scopes and cwd, even when several children are asking concurrently. The parent
receives instructions to relay the retry to the named child, not execute it
itself. Revocation and restored ledgers retain the same ownership boundary.


## Config

pi-nix's `programs.pi.coding-agent.autoMode` options write both halves'
config: auto mode's rules as `PI_AUTOMODE_SETTINGS_JSON`, and the permission
system's as `extensions/pi-permission-system/config.json` in pi's agent
directory, where it has always read them. `autoMode.askOnBlock` turns on
asking before a classifier block stands.

## Commands

`/permissions` is the one place for all of it, a menu in four tabs (Tab and
Shift+Tab, or ←/→, move between them; Esc closes). Ctrl+P opens the menu and
closes it from any tab or expanded denial details:

- **Denied**: what was blocked, newest first: command, command explanation,
  then denial reason, each on a separate truncated line. A supplied description
  is preferred; otherwise a tool-action summary explicitly notes missing purpose.
  `e` expands the full reason, explanation, command, approval scope and tool input,
  wrapped to fit. ↑/↓ (or j/k) scroll; `e` or Esc returns to the list.
  `a` (or Enter) approves the bounded shell scenario from either view and tells
  the agent. Capital `A` grants only the exact tool/input for the session: it
  bypasses the gates for that exact call, survives new instructions, and supplies
  no reusable scope to the auto classifier. It is not consumed after one retry.
  `x` dismisses a denial; the Allowed tab can revoke either kind of grant.
- **Allowed**: what you approved. `x` revokes.
- **Auto mode**: on or off for this session, the classifier model (opens a
  picker), the ask-before-block setting, this session's counts with a reset,
  reload, the decision log, and any config warnings.
- **Settings**: the permission system's switches (YOLO mode, the review log,
  debug logging, double-press to confirm—off by default) and its config file. pi-nix writes
  that file when pi starts, so a change here lasts until then.

`/permissions approve last` approves the newest block without the menu.
`/permissions auto` and `/permissions settings` open their respective tabs.
Subcommands remain available there, for example `/permissions auto status` and
`/permissions settings show`. The legacy `/automode`, `/auto-mode`, and
`/permission-system` commands are no longer registered.

When enabled, double confirmation applies to Enter and decision hotkeys in
the inline permission dialog; Escape still denies immediately. Auto-mode block
prompts and non-TUI selects remain single-confirmation surfaces.

The prompts and the menu are drawn as pi-custom draws its dialogs: framed, in
the editor's place, `❯` on the highlighted row.

## Files

| Path | What it is |
|---|---|
| `src/index.ts` | The entry: both halves, auto mode first, once per session; the ledger around their tool_call handlers; `/permissions` |
| `src/denials.ts` | What was blocked and what you approved, persisted in the session |
| `src/user-decisions.ts` | Validated questionnaire decisions from the native session |
| `src/ui/block-prompt.ts`, `block-prompt-state.ts` | The ask before a classifier block stands, with its countdown |
| `src/ui/menu.ts`, `menu-state.ts` | The `/permissions` menu |
| `src/ui/frame.ts`, `call-label.ts` | The dialog frame and how a call is named, after pi-custom's |
| `src/auto/` | pi-automode v1.17.0 `extensions/auto-mode/`, its entry as `index.ts` ([`LICENSE.md`](src/auto/LICENSE.md)) |
| `src/engine/` | pi-permission-system v40.0.1 `src/`, `#src/` imports made relative ([`LICENSE`](src/engine/LICENSE)) |
| `src/chain.test.ts` | The two joined: the chain link, the deterministic pre-pass, interrupt, ask-on-block, search redaction |
| `skills/automode-diagnostics/` | Auto mode's diagnostics skill, reading `docs/auto/` |

Changes to the vendored files carry a comment naming pi-permissions or pi-nix
where they are made. The two engines' own test suites run unmodified, except
where a marked assertion records one of those changes, in pi-nix's
`tests/permissions-upstream/`.
