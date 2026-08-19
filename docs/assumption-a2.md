# Assumption A2: is `tool_call` handler ordering observable?

**Yes, and it decides which gate runs.** Verified 2026-08-19 against pi
0.84.2's own dispatch code and the pinned `@gotgenes/pi-permission-system`
26.3.0 and `@czottmann/pi-automode` 1.11.0 tarballs, not against their docs.

The original answer to this question was "it does not arise", on the strength
of the permission system publishing a chain seam that the first-party
`pi-auto-mode` registered on. That seam was real. The arrangement built on it
was not.

## What pi actually does with two handlers

`dist/core/extensions/runner.js`, `emitToolCall`:

```js
for (const ext of this.extensions) {
  for (const handler of handlers) {
    const handlerResult = await handler(event, ctx);
    if (handlerResult) {
      result = handlerResult;
      if (result.block) return result;
    }
  }
}
```

Every extension's handler runs, sequentially, in `--extension` order, and the
first `{ block: true }` returns from both loops. Handlers after the blocker
never run. A handler that returns nothing means "no opinion, keep going".

Both packages register there. The permission system wraps
`gates.handleToolCall` in `createFailClosedToolCall` (`src/index.ts`);
pi-automode registers its own `pi.on("tool_call", ...)`
(`extensions/auto-mode/extension.ts`). The module concatenates
`extEntrypoints` before `autoModeEntrypoints`, so the permission system is
loaded first and answers first.

## Registration was never activation, and that is what shipped

The permission system consults a chain link only when the operator names it in
`authorizerChain`, in the package's own config file. With that list empty, the
composed chain **is** the terminal authorizer
(`src/authority/authorizer-chain.ts`: "with zero links the composed chain is
the terminal instance"), which is the local user, which is a dialog.

On the machine this fork is written for, that file read, in full:

```json
{ "debugLog": false, "permissionReviewLog": true, "yoloMode": false }
```

No `authorizerChain`. So `delegateToPermissionSystem = true` registered a link
that was never called, and every ask the deterministic engine could not settle
went to a dialog — including `git status --short --branch`, a command the
operator's own `allow` list names. The review log recorded it as
`"decidedBy": {"kind": "user", "via": "dialog"}`. The option evaluated, the
build was green, and the behaviour did not change.

That is the failure mode: configuration that reads as intent and does nothing,
because the half that arms it lives in another package's file.

## Why the replacement does not have this problem, and what it costs

`@czottmann/pi-automode` does not read
`Symbol.for("@gotgenes/pi-permission-system:service")` and calls
`registerAuthorizer` nowhere in its source. It cannot be a link in that chain,
so there is no version of "delegate to the permission system" to configure, and
`delegateToPermissionSystem` is gone rather than reworked.

What remains is a straight contention: two extensions gating one event, the
permission system first, prompting for what its engine cannot settle, and the
classifier never consulted. Running both is the shipped defect with the
packages swapped.

So the module refuses. `autoMode.enable` together with
`@gotgenes/pi-permission-system` in `extensionPackages` throws at eval, naming
both ways out. The consumer's answer is to drop the permission system, which
is what `modules/ai/pi.nix` in the dotfiles repo now does.

What that loses: the permission system's session approvals ("allow this for
the rest of the session"), its permission review log, its subagent forwarding,
and its deterministic prefix-allow rules (`Bash(git status:*)`), which resolve
without a model call. pi-automode has no allow-list fast path for `bash` at
all. Every side-effecting call reaches the classifier, and its cheap first
stage is one token wide precisely because that is the common case. What it
gains is that the classifier is actually asked, a deterministic hard-deny list
that runs before any model call, and a `hard_deny` tier the classifier is
structurally unable to clear.

## The mechanism the old note asked for still exists

`passthru.configFiles` (phase 7) installs a package-owned config file under
`$PI_CODING_AGENT_DIR` on every launch, and it is what would have written the
`authorizerChain` entry that was missing. It is still there, still used by
pi-intercom, and deliberately not used by auto mode: pi-automode's global
config path is anchored to `$HOME` rather than to `PI_CODING_AGENT_DIR`, and it
reads `PI_AUTOMODE_SETTINGS_JSON` as the highest-precedence source, so the
rules travel as an immutable store file exported into the environment instead.
A stale `~/.pi/agent/automode.json` from an earlier experiment cannot outrank
them, which is this note's lesson applied to the thing that replaced it.
