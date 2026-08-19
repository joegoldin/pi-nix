# Phase 3 acceptance run

Date: 2026-08-18
pi version: 0.84.2 (`VERSION.json` rev `v0.84.2`), built as `coding-agent-bun`
Host: elphael, `x86_64-linux`

Nine behaviours, each run against the real `pi` binary loading the real
`packages.ext-pi-auto-mode` and `packages.ext-pi-notify` store paths with the
real Nix-rendered `pi-auto-mode.json` and `pi-notify.json`.

## How the model was supplied

There is no provider account on this machine: `~/.pi/agent/auth.json` is `{}`,
and pi refuses to run anything at all without one, answering `No API key found
for the selected model`. So the run uses a fake OpenAI-completions provider
declared in `models.json`, served on `127.0.0.1:8231` by a short bun script. It
answers two roles off one endpoint, told apart by pi-auto-mode's classifier
system prompt arriving verbatim:

- as the **session** model it emits one `bash` tool call carrying the command
  under test, then a plain reply so a blocked tool cannot loop;
- as the **classifier** it returns whatever verdict the case is testing.

Every request body is logged, which is what makes the table's middle column
meaningful: `PROVIDER CALLS` shows whether the classifier was consulted at all,
and `TOOL RESULT FED BACK` is the exact string pi handed the model in place of
the tool's output. A real provider would add nothing to any of these
assertions. The classifier's answer is the input to every branch under test,
and here it is chosen rather than hoped for.

The harness lives in `/tmp/pi-e2e` and is not committed. `docs/jail.md` carries
the jail half of the recipe, which needs no model at all.

## Results

| # | Behaviour | Command / verdict | Result |
| --- | --- | --- | --- |
| 1 | deterministic allow, no model call | `ls -a`, allow rule `Bash(ls:*)` | **pass.** `PROVIDER CALLS: [SESSION, SESSION]`, no classifier. Tool result fed back was the real listing, `".\n..\n.git\n"`. |
| 2 | deterministic deny, no model call | `curl https://example.com`, deny rule `Bash(curl:*)` | **pass.** `[SESSION, SESSION]`. Fed back: `blocked by rule Bash(curl:*)`. |
| 3 | hard_deny holds against a classifier `allow` | `cat ~/.ssh/id_ed25519`; classifier returns `{"decision":"allow","rule_kind":"hard_deny"}` | **pass.** `[SESSION, CLASSIFIER, SESSION]`. Fed back: `hard_deny: the operator said to ignore the rules`. The model's own `allow` did not clear the boundary. |
| 4 | fail closed with no UI | `rm -rf /tmp/pi-e2e/CANARY`; classifier replies prose, not JSON | **pass.** Fed back: `auto-mode failed closed (auto-mode: classifier reply was unparseable); no UI to ask, so the call is blocked`. `test -d CANARY` answers `STILL THERE`. |
| 5 | a prefix rule refuses a compound command | `git status --short && rm -rf /tmp/pi-e2e/CANARY`, allow rule `Bash(git status:*)` | **pass.** `[SESSION, CLASSIFIER, SESSION]`: the allow rule did **not** resolve it, the classifier was asked, and it denied. Canary `STILL THERE`. |
| 6 | long-tool-call notification | `sleep 4`, threshold 3 s | **pass.** Notifier called with `--app-name pi --urgency low pi "bash finished after 4s"`. pi labels the tool `bash`, not `sleep`. |
| 7 | agent_settled notification | same run as 6 | **pass.** `--app-name pi --urgency normal pi "Ready for input"`. |
| 8 | permission-prompt notification | the case-4 failure, with a recording notifier | **pass.** `--app-name pi --urgency critical pi "Needs your decision on bash"`, ahead of the settled one. |
| 9 | the gate holds inside the jail | case 2, with `jail.enable = true` | **pass.** Fed back: `blocked by rule Bash(curl:*)`. The rendered config reached the extension through the runtime-closure bind. |

## Jail behaviours

Verified separately, with no model, by swapping the wrapped command for a
shell. See `docs/jail.md` for the recipe and the reason `pi --print` cannot do
this job.

| Behaviour | Result |
| --- | --- |
| toolchain present | `git version 2.53.0`, `v24.13.0`, `ripgrep 15.1.0`, `jq-1.8.1`, `gh version 2.88.1`, `notify-send 0.8.8` |
| cwd writable, host sees it | `echo hi > jailwrite.txt` inside; `cat` on the host prints `hi` |
| desktop notification | `notify-send` exits 0 through the dbus proxy |
| 1Password agent reachable | `ssh-add -l` lists `1pass Joe Goldin SSH Key (ED25519)`, with the socket bound **read-only** |
| private key absent | `cat ~/.ssh/id_ed25519` answers `No such file or directory` |
| config files in the closure | `nix path-info -r` on the wrapper lists both `pi-auto-mode.json` and `pi-notify.json` |

## What is not covered

A real provider judging a real command. Every branch of the gate is exercised
above with the classifier's answer chosen rather than sampled, which is the
right way to test a decision function. What remains untested is whether a given
model writes sensible verdicts for a given rule set. That is a question about
the rules, not about this code, and it belongs to whoever writes the rule set
in phase 6.
