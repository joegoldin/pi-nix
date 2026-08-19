# Assumption A2: is `tool_call` handler ordering observable?

**Yes, and it decides which gate runs, which is why the answer is not to
order them.** Verified 2026-08-19 against pi 0.84.2's own dispatch code and the
pinned `@gotgenes/pi-permission-system` 26.3.0 and `@czottmann/pi-automode`
1.11.0 tarballs, not against their docs.

This note has been wrong twice, in opposite directions. The first answer was
"it does not arise", on the strength of the permission system publishing a
chain seam that the first-party `pi-auto-mode` registered on. That seam was
real; the arrangement built on it was not, because registering a link is not
the same as activating one. The second answer was that the two packages cannot
be composed at all, which mistook a property of the published pi-automode for a
property of the problem. Both are corrected below: the seam is the answer, the
missing half is a config entry, and Nix now writes it.

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

## The fork, and what it costs

`@czottmann/pi-automode` does not read
`Symbol.for("@gotgenes/pi-permission-system:service")` and calls
`registerAuthorizer` nowhere in its source, so as published it cannot be a link
in that chain. That was read as "the two cannot be composed", and the module
threw when both were configured. The reading was wrong: what upstream cannot do
is a property of upstream, and this repo already forks pi.nix for exactly this
class of problem.

`joegoldin/pi-automode` v1.11.0-jg.1 adds one module,
`extensions/auto-mode/permission-chain.ts`, and six lines in the entrypoint.
`extensions/auto-mode/extension.ts`, the file holding the decision pipeline,
is upstream's byte for byte. The wrapper intercepts the factory's
`pi.on("tool_call", …)` registration rather than editing the handler, and calls
that same handler from the chain link, so a verdict the link returns and a
verdict the standalone gate returns come from one piece of code and cannot
drift. `packages/extensions/czottmann-pi-automode.nix` builds it from the tag;
the fork's own `docs/REBASING.md` names what an upstream change would cost.

Three properties the module is built around:

- **Absent means inert:** the symbol slot is read off `globalThis` rather than
  imported. With the permission system not installed the slot is empty, nothing
  registers, and the gate runs exactly as upstream's does. There is no
  dependency in either direction.
- **One pipeline:** the link reviews the real tool-call event, because auto
  mode is loaded ahead of the permission system and its handler sees the call
  before the ask is raised, and returns whatever the gate returns. In delegated mode the
  gate itself runs only the tiers that cost no model call, so nothing is
  classified twice and the permission system's own deterministic rules still
  resolve what they can.
- **`defer`, never `allow`, on failure:** a chain link that fails open widens
  permissions. A fail-closed *block* from the pipeline is a verdict and travels
  as a `deny`; an exception inside the link is not, and travels as a `defer`,
  which hands the ask back to the chain owner's own prompt.

## Registration is still not activation, and now Nix writes the file

The trap that produced F307 has not gone anywhere. A registered link decides
nothing until the operator names it in `authorizerChain`, and that file belongs
to the other package. What changed is who writes it:
`pi.coding-agent.autoMode.permissionSystem` renders
`extensions/pi-permission-system/config.json` through phase 7's
`configFiles`, which is the mechanism this note asked for the first time round.
An `authorizerChain` written by hand that omits the link is refused at eval
rather than installed.

`scripts/automode-e2e/pair-cases.sh` case 10 is the standing proof that the
entry is load-bearing: identical to case 3 in every respect except that array,
and the classifier is never consulted. `docs/automode-acceptance.md` has the
whole run.

## What the pairing costs, and what it buys

It costs the bounded-delegation checkpoint. The chain owner downgrades a link's
`allow` on the `path` and `external_directory` surfaces to `defer`
(`src/authority/delegation-envelope.ts`), so the classifier can refuse an
outside-the-tree file access but cannot approve one; that stays a prompt. `bash`
is not capped, and bash is where the volume is.

It buys back everything dropping the permission system had cost: session
approvals, the permission review log, subagent forwarding, and deterministic
prefix-allow rules such as `Bash(git status:*)` that resolve with no model call.
pi-automode has no allow-list fast path for `bash` at all, so on its own every
side-effecting call reaches the classifier. Now the rules resolve what they can
and the classifier answers what they cannot.

## The mechanism the old note asked for is in use

`passthru.configFiles` (phase 7) installs a package-owned config file under
`$PI_CODING_AGENT_DIR` on every launch. It is what writes the `authorizerChain`
entry that was missing, alongside pi-intercom's `inboundTrigger`.

It is still the wrong mechanism for auto mode's *own* config, and for the reason
F308 gives: that contract installs relative to `PI_CODING_AGENT_DIR`, while
pi-automode's global config path is `resolve(HOME, ".pi/agent/automode.json")`
(`constants.ts`), anchored to the home directory. They agree by default and only
by default. The rules travel as `PI_AUTOMODE_SETTINGS_JSON` instead, which the
package treats as its highest-precedence source, so a stale
`~/.pi/agent/automode.json` from an earlier experiment cannot outrank them.
