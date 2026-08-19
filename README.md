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
| `autoMode.enable` | bool | `false` | The `pi-auto-mode` permission classifier. |
| `autoMode.allow` | `[str]` | `[ ]` | Pre-approved actions, as plain sentences for the classifier. |
| `autoMode.soft_deny` | `[str]` | `[ ]` | Destructive actions that explicit user intent clears. |
| `autoMode.hard_deny` | `[str]` | `[ ]` | Security boundaries. Intent does not clear these and cannot. |
| `autoMode.environment` | `[str]` | `[ ]` | Facts about the machine. Not permissions. |
| `autoMode.deterministic.allow` | `[str]` | `[ ]` | Claude Code rule syntax, resolved without a model call: `Bash(git status:*)`, `Read(/home/joe/**)`. |
| `autoMode.deterministic.deny` | `[str]` | `[ ]` | Same syntax. Deny beats allow. |
| `autoMode.model` | `null \| { provider; modelId; }` | `null` | Classifier model. Null uses the session's own. |
| `autoMode.userTurnLimit` | int | `6` | How many user turns the classifier sees, which is what makes `soft_deny` clearable. |
| `autoMode.timeoutMs` | int | `20000` | Classifier timeout. On expiry auto mode fails closed. |
| `autoMode.delegateToPermissionSystem` | bool | `false` | Register on `@gotgenes/pi-permission-system`'s authorizer chain. See `docs/assumption-a2.md`: this also needs an `authorizerChain` entry on that package's side. |
| `messaging.enable` | bool | `false` | Peer messaging between separately launched pi instances, over a local unix socket. |
| `messaging.package` | package | `ext-pi-intercom` | The messaging extension. Must satisfy the `mkPiExtension` passthru contract. |
| `messaging.inboundTrigger` | enum | `replies` | Whether an inbound peer message may start a model turn. Upstream ships `always`; this fork does not. |
| `messaging.confirmSend` | bool | `false` | Confirm ordinary outbound messages. Replies are never gated. |
| `messaging.askTimeoutSeconds` | int | `300` | How long a blocking request to a peer waits. Upstream's default is 600. |
| `messaging.installSkill` | bool | `false` | Also pass the extension's bundled skills via `--skill`. |

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

Three layers, outermost first: the jail contains, a deterministic matcher
resolves the clear-cut majority with no model call, and a classifier judges only
what the matcher left as `ask`.

Two properties are load-bearing, and both are tested against a live pi in
`docs/phase-3-acceptance.md`.

**It fails closed.** A classifier that errors, times out, returns unparseable
output, or has no model never lets a call through. With a UI it degrades to a
confirmation dialog; in `print` and `json` mode it blocks. A malformed config
file enables auto mode with nothing pre-approved rather than disabling it.

**`hard_deny` is a floor, not a preference.** The gate blocks a `hard_deny` even
when the classifier answers `allow`, and does not offer the operator a dialog to
wave it through. The model is not trusted to enforce the one rule it is told it
may not clear, so text injected into a file or a tool call cannot talk its way
past one.

One sharp edge worth knowing about the deterministic layer: it has no shell
parser, so a `Bash(...)` prefix rule refuses to **allow** any command containing
a control operator. `git status && rm -rf /` starts with `git status `, and the
matcher would otherwise wave it through. Such a command falls to the classifier
instead. Deny rules are unaffected, because refusing to deny is the unsafe
direction. Delegating to `@gotgenes/pi-permission-system` is what closes this
gap properly: that package carries tree-sitter-bash.

Config reaches both first-party extensions as a store path in an environment
variable, `PI_AUTO_MODE_CONFIG` and `PI_NOTIFY_CONFIG`, never through
`settings.json`. pi's `ExtensionContext` exposes no settings reader, so a
`settings.json` block would be config nothing can read.

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
| `ext-pi-auto-mode` | `packages/extensions/pi-auto-mode` | Claude-Code-style auto mode: deterministic rules plus a fail-closed classifier |
| `ext-pi-notify` | `packages/extensions/pi-notify` | Desktop notifications on prompts, settle, and long tool calls |

Their tests run under `nix flake check` as `pi-auto-mode` and `pi-notify`. Each
check runs the suite twice over one tree: `bun test`, with
`PI_CODING_AGENT_SRC` pointed at the pi source `packages.coding-agent` builds
from so the contract tests read pi's real tool schemas, and then `tsc --strict`
against pi 0.84.2's published `.d.ts`. A pi bump that moves the extension API
fails there rather than at load.

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
