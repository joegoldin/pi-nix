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
| `notifications.package` | `null \| package` | `null` | The `pi-notify` derivation. Enabling without one is an error, not a no-op. |
| `notifications.notifierCommand` | str | `notify-send` / `terminal-notifier` | Absolute path to the notifier, resolved at build time so it survives the jail. |
| `notifications.events` | `[enum]` | all three | `needs_input`, `settled`, `long_running_tool`. |
| `notifications.longRunningToolSeconds` | int | `30` | Threshold for `long_running_tool`. |

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
