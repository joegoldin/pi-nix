# The pi jail

`programs.pi.coding-agent.jail.enable = true` wraps pi in bubblewrap via
jail.nix. Linux only; upstream throws on Darwin.

Upstream's default is `[ network mount-cwd ]`, which reaches a model API and
edits the working directory and nothing else: no git, no node, no dbus. pi-nix
widens it. The widening arrives as `lib.mkDefault` from
`coding-agent/extra-options.nix`, not as an edit to the option's own default,
because `coding-agent/options.nix` is upstream's file and is hashed
byte-identical by `tests/additive-test.nix`. So the option's `defaultText` in
generated docs still shows upstream's two entries; this page is the real list.

Write `jail.permissions = ...` yourself and you replace the whole list. Nothing
merges it: the option is `functionTo (listOf raw)` and function-typed options do
not merge across definitions.

## What the default grants

| Permission | Why |
| --- | --- |
| `network` | Model API access. |
| `mount-cwd` | The working directory, read-write. |
| `notifications` | dbus talk on `org.freedesktop.Notifications`, without which pi-notify is silently inert inside the jail. |
| `add-pkg-deps [...]` | The toolchain pi shells out to: git, openssh, make, jq, node, python3, ripgrep, fd, gh, libnotify. |
| `try-readonly ~/.1password/agent.sock` | Agent-backed SSH and commit signing. |
| `try-readonly ~/.ssh/known_hosts`, `known_hosts2`, `config` | Host-key verification and per-host config. |
| `try-fwd-env SSH_AUTH_SOCK` | So git finds the agent. |

## What it deliberately does not grant

`~/.ssh/id_*`. This mirrors `dotfiles/modules/ai/claude.nix`, where the same
four paths are the entire `extraSandbox.filesystem.allowRead` list and private
keys are omitted on purpose: the 1Password agent is the supported signing path
on this machine. The jail is the layer that makes that omission enforceable.

Verified inside the jail: `cat ~/.ssh/id_ed25519` answers `No such file or
directory`.

## The socket, and one prediction that did not hold

The plan expected `try-readonly` to break the agent, on the reasoning that
connecting to an `AF_UNIX` socket needs write permission on the inode, and that
bubblewrap's `--ro-bind` therefore denies it.

Measured on this machine, it does not. With `--ro-bind-try` on
`~/.1password/agent.sock`, `ssh-add -l` inside the jail listed the key. So the
default is read-only, which matches the Claude allowlist exactly rather than
approximately.

If a kernel ever disagrees the failure is loud (`Error connecting to agent:
Permission denied`) and the fix is one line:

    (combinators.try-readwrite (combinators.noescape "~/.1password/agent.sock"))

Change that line only. The three `~/.ssh` entries are read-only data and must
stay read-only.

## `with combinators` is a trap in this file

`coding-agent/extra-options.nix` binds `notifications = cfg.notifications` in
the same `let`. A `with combinators;` inside that scope loses to the enclosing
binding, so `notifications` resolves to the option submodule and jail.nix is
handed an attrset where it expects a function. It fails late, at
`finalPackage`, with `attempt to call something which is not a function but a
set`. Every combinator in that list is written `combinators.x` for this reason.

## Config files

`pi-automode.json` and `pi-notify.json` are store paths interpolated into the
launcher script, so they enter its runtime closure and jail.nix binds them with
the rest of the store closure. Verified:

    nix path-info -r "$(…agent.package)" | grep -E 'pi-automode\.json|pi-notify\.json'

prints both. The auto-mode one is read by `$(cat …)` into
`PI_AUTOMODE_SETTINGS_JSON` before pi starts, so the bind has to be there even
though nothing opens the file after launch.

## Verifying a change

The jail wrapper is a bash script whose last line is one `bwrap` invocation. To
exercise the sandbox without a model or an API key, swap the command it runs:

    sed 's| -- /nix/store/.*-pi-coding-agent-bun-.*/bin/pi "$@"| -- /bin/sh -c "$1"|' \
      "$JAILED/bin/pi" > /tmp/jailsh && chmod +x /tmp/jailsh
    cd /some/repo && /tmp/jailsh 'git --version; node --version; ssh-add -l'

`pi --print` cannot stand in for this: it needs a configured provider before it
will run anything at all.
