# pi-nix

A Nix flake for [pi](https://github.com/earendil-works/pi), the terminal coding
agent. It forks [lukasl-dev/pi.nix](https://github.com/lukasl-dev/pi.nix) and
extends it for the agent stack described in
`agent-skills/docs/plans/2026-08-18-pi-nix-agent-stack-design.md`.

Upstream provides the packages, the NixOS/Home Manager modules, the jail.nix
sandbox wiring, and `lib.mkCodingAgent`. This fork adds, all additively:

| Addition | What it is |
| --- | --- |
| `systemPrompt` | `--system-prompt`, which *replaces* pi's default prompt. Upstream's `rules` only appends. |
| Bun by default | `programs.pi.coding-agent.package` defaults to upstream's `coding-agent-bun`. Set it explicitly to get the npm build back. |
| `packages.ext-*` | Ecosystem extensions, fully pinned and built from npm tarballs with `bun2nix`. |
| `extensionPackages` | Enable a pinned extension by listing its derivation; entrypoints, skills, prompts, and settings follow from its `passthru`. |
| `statusline` | Wires the [agent-statusline](https://github.com/joegoldin/agent-statusline) pi extension and its config JSON. |
| `notifications` | Option surface for the first-party `pi-notify` extension. |
| `lib/` | `mkPiSkill` / `mkPiPromptTemplate` / `mkPiPlugin`, the builders `agent-skills` imports as `piLib`. |
| `nix run .#update` | Bumps `VERSION.json` *and* every extension pin in `extensions.json`. |

See [docs/REBASING.md](docs/REBASING.md) before pulling upstream.

## Quick start

```bash
nix run github:joegoldin/pi-nix --accept-flake-config
```

That runs upstream's `packages.default`, which is the npm build. The Home
Manager and NixOS modules default to the Bun build instead; `nix run
github:joegoldin/pi-nix#coding-agent-bun` runs the same binary they install.

## Binary cache

Upstream's cachix config is retained. Add both substituters, or pass
`--accept-flake-config`:

```nix
nix.settings = {
  extra-substituters = [
    "https://pi.cachix.org"
    "https://nix-community.cachix.org"
  ];
  extra-trusted-public-keys = [
    "pi.cachix.org-1:lGeoGJaZ5ZDabuRzkcD5EBTNnDM4HJ1vqeOxlWk1Flk="
    "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
  ];
};
```

## Home Manager

```nix
{ inputs, pkgs, ... }:
{
  imports = [ inputs.pi-nix.homeModules.default ];

  programs.pi.coding-agent = {
    enable = true;
    systemPrompt = ./SYSTEM.md;
    extensionPackages = with inputs.pi-nix.packages.${pkgs.system}; [
      ext-pi-mcp-adapter
      ext-pi-subagents
      ext-juicesharp-rpiv-todo
      ext-juicesharp-rpiv-ask-user-question
      ext-narumitw-pi-goal
    ];
    statusline.enable = true;
  };
}
```

## Known upstream behaviour, retained

Upstream's `settings` option jq-merges into `~/.pi/agent/settings.json` on every
launch rather than writing a store symlink. That is deliberate, because pi
writes to that file itself via `/login` and `/model`. It does mean a
Nix-declared setting wins over an interactive `/model` choice on the next run,
which is the same trade-off `dotfiles/modules/ai/codex.nix` already documents.

## Options

Everything upstream documents under `programs.pi.coding-agent` still applies.
This fork adds:

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `package` | package | `coding-agent-bun` | Upstream declares this option with `coding-agent` as the default; the fork lowers a `mkDefault` onto it so the Bun build wins. Set it explicitly for the npm build. |
| `systemPrompt` | `null \| lines \| path` | `null` | `--system-prompt`, **replacing** pi's default prompt. Composes with `rules`, which still appends. |
| `extensionPackages` | `[package]` | `[ ]` | Enable pinned extensions. Entrypoints, skills, prompts, and settings all follow from each derivation's `passthru`. |
| `statusline.*` | submodule | `{ }` | The shared agent-statusline schema, mounted under pi's namespace. |
| `statusline.extension` | package | this flake's `pi-extension` | The extension package handed to `--extension`. |
| `notifications.enable` | bool | `false` | Desktop notifications via the first-party `pi-notify` extension. |
| `notifications.package` | `null \| package` | `ext-pi-notify` | The `pi-notify` derivation. Enabling with a null one is an error, not a no-op. |
| `notifications.notifierCommand` | str | `notify-send` / `terminal-notifier` | Absolute path to the notifier, resolved at build time so it survives the jail. |
| `notifications.style` | enum | `notify-send` / `terminal-notifier` | Which argv contract `notifierCommand` speaks. Change the two together: a mismatch is silent. |
| `notifications.appName` | str | `pi` | Title, and the `--app-name` the desktop groups by. |
| `notifications.events` | `[enum]` | all three | `needs_input`, `settled`, `long_running_tool`. |
| `notifications.longRunningToolSeconds` | int | `30` | Threshold for `long_running_tool`. |
| `autoMode.enable` | bool | `false` | The `@czottmann/pi-automode` guardrail. Conflicts with `@gotgenes/pi-permission-system`; see `docs/assumption-a2.md`. |
| `autoMode.package` | package | `ext-czottmann-pi-automode` | The auto-mode extension derivation. |
| `autoMode.allow` | `[str]` | `[ ]` | Exceptions to `soft_deny`, as plain sentences for the classifier. A non-empty list replaces the package's built-ins; add `$defaults` to keep them. |
| `autoMode.soft_deny` | `[str]` | `[ ]` | Destructive actions that explicit user intent clears. |
| `autoMode.hard_deny` | `[str]` | `[ ]` | Security boundaries. Intent does not clear these and cannot. |
| `autoMode.environment` | `[str]` | `[ ]` | Facts about the machine. Not permissions. |
| `autoMode.protectedPaths` | `[str]` | `[ ]` | Paths whose writes always reach the classifier. `$defaults` keeps the built-in 48. |
| `autoMode.deniedPaths` | `[str]` | `[ ]` | Globs the file tools may never touch, matched before any classifier or fast path. |
| `autoMode.permissions.deny` | `[str]` | `[ ]` | Tool patterns blocked with no model call: `bash(rm -rf *)`, `write(.env*)`. |
| `autoMode.permissions.ask` | `[str]` | `[ ]` | Tool patterns that prompt first. With no UI a match blocks. |
| `autoMode.classifierModel` | `null \| str` | `null` | `provider/model-id`. Null uses the session's own model. |
| `autoMode.classifierReasoningLevel` | `null \| enum` | `null` | `low`…`max`. Null leaves the choice to the provider. |
| `autoMode.classifyReadOnlyTools` | `null \| bool` | `null` | Send `read`/`grep`/`find`/`ls` to the classifier too. |
| `autoMode.allowInsideWorkingDirectory` | `null \| bool` | `null` | Deterministic allow for in-tree file access; out-of-tree access is classified. |
| `autoMode.fastClassifierMaxTokens` | `null \| int` | `null` | Budget for the one-token first stage. Package default 512. |
| `autoMode.maxUserTranscriptTokens` | `null \| int` | `null` | How much user text the classifier sees, which is what makes `soft_deny` clearable. Package default 4000. |
| `autoMode.maxToolTranscriptTokens` | `null \| int` | `null` | Budget for the agent's own tool-call inputs. Package default 4000. |
| `autoMode.log.enable` | bool | `false` | JSONL decision log beside the session file. |
| `autoMode.log.classifierIo` | bool | `false` | Also log the classifier's prompt, responses, and parsed verdict. |
| `jail.nixAccess` | bool | `false` | Put `nix` in the jail, with the store read-only and the daemon socket read-write. |
| `messaging.enable` | bool | `false` | Peer messaging between separately launched pi instances, over a local unix socket. |
| `messaging.package` | package | `ext-pi-intercom` | The messaging extension. Must satisfy the `mkPiExtension` passthru contract. |
| `messaging.inboundTrigger` | enum | `replies` | Whether an inbound peer message may start a model turn. Upstream ships `always`; this fork does not. |
| `messaging.confirmSend` | bool | `false` | Confirm ordinary outbound messages. Replies are never gated. |
| `messaging.askTimeoutSeconds` | int | `300` | How long a blocking request to a peer waits. Upstream's default is 600. |
| `messaging.installSkill` | bool | `false` | Also pass the extension's bundled skills via `--skill`. |
| `voice.enable` | bool | `false` | Dictation through the first-party `pi-voice` extension, over `audiomemo record --stream`. |
| `voice.package` | package | `ext-pi-voice` | The `pi-voice` derivation. Must satisfy the `mkPiExtension` passthru contract. |
| `voice.audiomemo` | package | *(none)* | The audiomemo package providing `record`. No default: the jail binds this exact derivation's closure. |
| `voice.device` | `null \| str` | `null` | Device alias or name passed as `-D`. Null defers to audiomemo's own config, whose picker is an interactive TUI. |
| `voice.extraArgs` | `[str]` | `[ ]` | Further `record` arguments. `--stream` and `-t` are always passed. |
| `voice.barWidth` | int | `12` | Width of the VU bar, in cells. |
| `voice.placement` | enum | `belowEditor` | Where the voice widget sits relative to the editor. |
| `voice.keyFiles` | `{str: str}` | `{ }` | `*_API_KEY_FILE` paths. audiomemo opens the files itself, so no secret enters the store. Each is bound read-only into the jail. |
| `voice.configFile` | `null \| str` | `null` | audiomemo's config file, bound read-only into the jail. Without it `record` tries to onboard and dies on `/dev/tty`. |
| `voice.jailPermissions` | function | read-only | The jail entries voice needs, for a consumer who replaces `jail.permissions` outright. |

### Voice

`/voice` starts and stops dictation. pi-voice spawns `audiomemo record
--stream`, which writes one JSON object per line while it records: the mic
level, the live partial text, the committed text, and one final transcript.
The extension draws two rows below the editor: a record dot, a clock, a VU
bar, a dB readout, and the transcript with the moving partial dimmed. The
finished text arrives in the editor through `ctx.ui.pasteToEditor`.

Every decision about devices, backends, formats, and secrets stays in
audiomemo. Keys travel as `*_API_KEY_FILE` paths and audiomemo opens the files
itself, so no key value reaches the store or any process environment.

While the microphone is live, pi-voice merges `{"voice":{"enabled":true,"mode":
"toggle"}}` into `$CLAUDE_CONFIG_DIR/settings.local.json`, which is the file
agent-statusline's `voice` widget already reads. The contract is
harness-independent: any producer that owns the microphone can write it, and
the same widget lights under pi and under Claude Code. Stopping writes
`enabled: false` rather than deleting the key, because an absent key lets a
lower settings layer answer instead.

Inside the jail the microphone is not merely restricted without
`voice.jailPermissions`: it is absent. `audiomemo record -L` with no audio
socket bound lists zero devices and exits zero, the same silent-empty failure
this fork already documents for API keys. Measured on 2026-08-18: 0 lines
without the bind, 8 with it. `/dev/snd` is not involved, because audiomemo
shells to `ffmpeg -f pulse` and never touches ALSA. The module's own `jail.permissions`
default already carries these entries, so a consumer who leaves that option
alone, or defines it with `mkDefault`, needs nothing further.

### Messaging

pi has no equivalent of Claude Code's `ListAgents` and `SendMessage`, so two pi
sessions started in different terminals cannot see or reach each other.
`messaging.enable` fixes that with `pi-intercom` over a unix domain socket at
`$PI_CODING_AGENT_DIR/intercom/broker.sock`. No relay, no daemon, no network,
and no remote or phone access: the package contains no network code at all.

Two defaults differ from upstream's, and both are security decisions rather
than taste.

**`inboundTrigger` is `replies`.** The broker authenticates nobody. Any process
running as this user can open the socket, register, and send. Upstream's
`always` makes such a message start a model turn immediately, with the text
arriving as a *user* message, which routes around every permission layer: those
gate tool calls, not the provenance of instructions. Under `replies` only a
reply to a request this session originated may start a turn. Unsolicited
messages are still delivered and rendered. Raising this to `always` is a
per-host choice, not a convenience.

**The broker refuses a live session-ID collision.** Upstream lets a client pick
its own `sessionId` at register time and, when a live session already holds it,
ends the incumbent's socket and hands the ID over. No flag is needed, and the ID
is not secret: any registered peer may call `list`, and `list` returns every
session's UUID along with its cwd, model and pid. `packages/extensions/pi-intercom-patches.nix`
replaces that branch with a refusal, and `checks.pi-intercom-smoke` fails
against the unpatched tarball.

What neither fixes: a process under this uid can still connect, still enumerate
every session, and still deliver text. The package exposes no peer credential to
check, so presence on the socket cannot be refused. `prompt/untrusted-peer-input.md`
is what tells the model that the name a message arrives under is a claim rather
than a fact.

`brokerCommand` is written as a bun store path with empty `brokerArgs`.
Upstream's default launch path calls `getNodeCommand(process.execPath)`, which
falls back to the literal string `node` resolved through `PATH` whenever the
interpreter is not Node, and under the Bun build it never is. Pointing it at a
store path means nothing resolves through `PATH` and `tsx` is never invoked, so
the package needs no `node_modules`.

### Verified assumptions

Design assumptions the messaging work resolved by measurement rather than by
reading documentation. Each row names the command that settled it.

| # | Assumption | Outcome | How |
| --- | --- | --- | --- |
| A6 | pi resolves an extension's bare imports through the `NODE_PATH` its wrapper exports, including under Bun | **holds** | `NODE_PATH=$(nix build .#coding-agent-bun)/lib/node_modules bun probe.js` resolved `typebox` to a function |
| A7 | `bun broker/broker.ts` starts the broker with no `node_modules`, so `tsx` can be dropped | **holds** | ran it in the unpacked tarball with no `node_modules`: `Intercom broker started`, and `0700`/`0600` on the socket tree |
| A9 | A broker auto-spawned inside one bubblewrap jail is reachable from a second, differently-mounted jail | **holds** | `./scripts/verify-jail-socket.sh`: jail A binds the socket, jail B registers across it |
| A8 | `inboundTrigger = "replies"` still *delivers* unsolicited sends rather than dropping them | **open** | needs a live pi in two terminals; not resolvable by a check |

### Auto mode

Three layers, outermost first: the jail contains, a deterministic tier resolves
what needs no judgement, and a two-stage classifier judges the rest.

The deterministic tier is `permissions.deny`, declined `permissions.ask`, the
package's own hard-deny checks (shell profile writes, `authorized_keys`, cron
and launch-agent persistence, TLS and auth weakening, root and home destructive
deletes, edits to auto-mode's own config), and `deniedPaths`. None of it costs a
model call. Everything that survives it and is not a read-only tool goes to the
classifier, `write` and `edit` included, so a direct file write cannot route
around a rule the classifier holds.

Two properties are load-bearing, and both are tested against a live pi in
`docs/automode-acceptance.md`.

**It fails closed.** A classifier that errors, times out, returns unparseable
output, or names a model that does not resolve never lets a call through. A
`permissions.ask` match with no UI blocks rather than proceeding.

**`hard_deny` is a floor, not a preference.** The verdict contract refuses the
combination outright: `{"decision":"allow","tier":"hard_deny"}` does not parse,
and an unparseable verdict blocks. The model is not trusted to clear the one
rule it is told it may not clear, so text injected into a file or a tool call
cannot talk its way past one.

There is no allow list for `bash`, and that is the design rather than a gap.
A prefix rule with no shell parser will wave through `git status && rm -rf /`,
which starts with `git status `; the answer here is that every `bash` call is
classified and the first stage is one token wide to keep that cheap.

The rules reach the extension as `PI_AUTOMODE_SETTINGS_JSON`, exported from a
store file the launcher `cat`s, never through `settings.json`, which the
package does not read. That variable is its highest-precedence source, so a
stale `~/.pi/agent/automode.json` cannot outrank the declared policy. pi-notify
takes the same shape for the same reason, as `PI_NOTIFY_CONFIG`: pi's
`ExtensionContext` exposes no settings reader.

Auto mode and `@gotgenes/pi-permission-system` cannot both run. Both gate
`tool_call`, pi stops at the first extension that blocks, and the permission
system loads first. Enabling both throws at eval; `docs/assumption-a2.md` has
the evidence and what dropping the permission system costs.

### The jail

`jail.enable = true` wraps pi in bubblewrap. The fork replaces upstream's
two-entry default with the toolchain pi shells out to, a dbus talk permission on
`org.freedesktop.Notifications`, and the same four read-only paths
`modules/ai/claude.nix` allows Claude, private keys deliberately excluded. It
arrives as `mkDefault`, so your own `jail.permissions` still wins and the
option's `defaultText` still shows upstream's. `docs/jail.md` is the real list.

Turning `statusline.enable` on exports two variables through `environment`, so
`environment` has to be in its attribute-set form. The shell-environment-file
form cannot merge with them and evaluation fails.

Pinned extensions are exposed as `packages.<system>.ext-<slug>`:

| Attribute | npm package | What it adds |
| --- | --- | --- |
| `ext-pi-mcp-adapter` | `pi-mcp-adapter` | MCP, which pi omits |
| `ext-pi-subagents` | `pi-subagents` | subagents |
| `ext-pi-background-tasks` | `pi-background-tasks` | background bash |
| `ext-juicesharp-rpiv-ask-user-question` | `@juicesharp/rpiv-ask-user-question` | AskUserQuestion |
| `ext-narumitw-pi-goal` | `@narumitw/pi-goal` | `/goal`, pushing rather than vetoing |
| `ext-juicesharp-rpiv-todo` | `@juicesharp/rpiv-todo` | todos |
| `ext-gotgenes-pi-permission-system` | `@gotgenes/pi-permission-system` | deterministic permissions |
| `ext-narumitw-pi-btw` | `@narumitw/pi-btw` | side questions off the main thread |
| `ext-pi-cache-optimizer` | `pi-cache-optimizer` | prefix-cache hit rate |
| `ext-heyhuynhgiabuu-pi-pretty` | `@heyhuynhgiabuu/pi-pretty` | TUI syntax highlighting |

Two more are first-party, built from `packages/extensions/` in this repo rather
than from a pin. They carry no lockfile because they have no runtime
dependency: both import from `@earendil-works/*` with `import type` only, which
TypeScript erases.

| Attribute | Source | What it adds |
| --- | --- | --- |
| `ext-pi-notify` | `packages/extensions/pi-notify` | Desktop notifications on prompts, settle, and long tool calls |
| `ext-pi-voice` | `packages/extensions/pi-voice` | Push-to-talk dictation into the editor |

Their tests run under `nix flake check` as `pi-notify` and `pi-voice`. Each
check runs the suite twice over one tree: `bun test`, with
`PI_CODING_AGENT_SRC` pointed at the pi source `packages.coding-agent` builds
from, and then `tsc --strict` against pi 0.84.2's published `.d.ts`. A pi bump
that moves the extension API fails there rather than at load.

Auto mode used to be a third. It is now the pinned `@czottmann/pi-automode`,
which speaks Claude Code's own `autoMode` schema and ships the deterministic
hard-deny list, the path deny list, and the transcript budgets the first-party
one never had. `docs/assumption-a2.md` records why the first-party one was
retired and why it cannot run alongside `@gotgenes/pi-permission-system`.

Bump every pin, and pi itself, with one command:

```sh
nix run .#update
```

`nix run .#update-extensions` bumps only the extension pins, regenerating each
one's `bun.lock` and `bun.nix` as it goes. Neither ever rewrites the `bundled`
or `entrypoints` fields in `extensions.json`. Those are human decisions about a
package, not facts read off the registry.

Generate the full reference:

```sh
nix build .#docs-md
nix build .#docs-html
```

## Upstream

Upstream's own README, cachix cache, and issue tracker remain the reference for
everything not in the table above. See
[earendil-works/pi#2310](https://github.com/earendil-works/pi/issues/2310) for
why an official flake does not exist.
