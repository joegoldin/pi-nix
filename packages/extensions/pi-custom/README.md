# pi-custom

This setup's own pi extension: one package, loaded once, with each part in its
own directory under `src/`. `src/index.ts` registers them against the same pi
and nothing else; the parts share no code.

| Part | What it does | Replaces |
|---|---|---|
| [`src/ui/`](src/ui/README.md) | How a session looks and finds things: Claude Code-style tool cards and diffs, markdown touches, the prompt box and shimmer, `/ui`, `/context`, `@session:` and `@agent:` references, find/grep and `@` file completion through FFF | pi-pretty and the pi-cc-extensions features, rewritten |
| [`src/extras/`](src/extras/README.md) | Prompt and session handling: the prompt stash and its chords, `/exit`, `/clear`, `/clone-session`, `/stash`, the working tab title, and keeping git from opening an editor | the old first-party pi-extras |
| [`src/tools/`](src/tools/README.md) | What the model can do beyond pi's built-ins: background shell tasks, a todo list, structured questions, `/goal`, `/btw` | pi-background-tasks, rpiv-todo, rpiv-ask-user-question, pi-goal, pi-btw |
| [`src/intercom/`](src/intercom/README.md) | Messaging with other agent sessions on the machine, pi and Claude Code: the `intercom` tool, one inbox, `/intercom`, `/handover`, and the hooks pi-subagents uses | pi-intercom, pi-claude-link |

[ATTRIBUTION.md](ATTRIBUTION.md) credits the projects each part is modelled on.

## Enabling it

pi-nix builds it as a first-party extension (`default.nix`). In a profile:

```nix
programs.pi.coding-agent.custom = {
  enable = true;
  # What copy and cut pipe to: pbcopy on darwin, wl-copy elsewhere by default,
  # null to drop those chords. Under the jail it runs on the host, reached
  # through a jail-to-host channel.
  clipboardCommand = "pbcopy";
  # What git gets as its editor; `true` by default, so git keeps the message
  # it has instead of waiting for one.
  gitEditorCommand = "true";
};
```

Intercom is off until the `messaging` option turns it on; that option writes
its config and puts bun in the jail for the broker:

```nix
programs.pi.coding-agent.messaging = {
  enable = true;              # needs custom.enable
  claude.enable = true;       # join Claude Code's peer list (off under the jail)
};
```

The custom options set two environment variables the code reads, `PI_CUSTOM_CLIPBOARD`
and `PI_CUSTOM_GIT_EDITOR`. Without Nix both are optional: the clipboard falls
back to wl-copy, xclip or pbcopy, and git's editor to `true`.

## Settings and state

- `~/.pi/agent/pi-custom.json` (or under `$PI_CODING_AGENT_DIR`): every
  setting `/ui` shows, including the `/goal` turn limits. Unknown or malformed
  values fall back to their defaults rather than failing the session.
- `~/.pi/agent/pi-custom/stash.json`: the prompt stash.
- `.pi/tasks/` in the project: background task logs.
- `~/.pi/agent/intercom/`: intercom's config (written by the `messaging`
  option, which is what turns intercom on), broker socket and log.
- `~/.claude/sessions/<pid>.json` and a socket beside Claude Code's own: this
  session's entry in Claude's peer list, removed when the session ends.

The todo list and goal state live in the session itself, so they follow
branches and compaction.

## Developing

```sh
bun test              # unit tests for every part
bunx tsc --noEmit     # strict type check
nix build .#checks.<system>.pi-custom   # both, as pi-nix's flake check runs them
```

Tests sit beside the code they cover (`*.test.ts`). Logic that does not need a
terminal (formats, state machines, validation) lives in its own module so it
can be tested without pi; the files that register against pi stay thin.
