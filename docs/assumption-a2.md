# Assumption A2: is `tool_call` handler ordering observable?

**The question does not arise.** Verified 2026-08-18 against the pinned
`@gotgenes/pi-permission-system@26.3.0` tarball, not against its docs.

The package does not need ordering to cooperate with another extension. It
publishes a typed `PermissionsService` on
`Symbol.for("@gotgenes/pi-permission-system:service")` (`src/service.ts:66`) and
exposes `registerAuthorizer(name, authorize)` (`dist/public.d.ts:532`), a chain
seam invoked only for asks its deterministic engine could not resolve.
`pi-auto-mode` registers there, so the classifier is layer 3 by construction
rather than by luck.

`pi-auto-mode` reads the symbol slot directly and never imports the package, so
it has no dependency on it. When the extension is absent the slot is empty,
`attachAuthorizer` answers `false`, and the built-in matcher in `src/rules.ts`
runs. That is the fallback state design §9's build order asked to have shipped.

Chain-link failure returns `defer`, never `allow`: deferring hands the ask back
to the chain owner's own prompt path, which is that layer's fail-closed
behaviour.

## Registration is not activation

`registerAuthorizer`'s own docstring says the chain consults a link only when
"the operator names it in the `authorizerChain` config". That config is
`~/.pi/agent/extensions/pi-permission-system/config.json`, the package's own
file, honouring `PI_CODING_AGENT_DIR`. It is **not** pi's `settings.json`, so
neither `mkPiExtension`'s `passthru.settings` nor the module's `settings` option
can write it.

So `programs.pi.coding-agent.autoMode.delegateToPermissionSystem = true` is half
the wiring. The other half is an operator edit on the permission system's side:

    { "authorizerChain": ["pi-auto-mode"] }

Phase 7 added `passthru.configFiles` to the extension contract for exactly this
class of problem (a package whose settings live outside `settings.json`), and
the launcher now installs every entry under `$PI_CODING_AGENT_DIR`. So the
mechanism exists: giving `ext-gotgenes-pi-permission-system` a

    configFiles."extensions/pi-permission-system/config.json" = {
      authorizerChain = [ "pi-auto-mode" ];
    };

would write the chain entry from Nix, at 0600, on every launch. That edit is not
made here, because `authorizerChain` is the operator's list rather than one
extension's to claim: writing it unconditionally would silently overwrite a
chain a consumer had ordered themselves. Wiring it to
`autoMode.delegateToPermissionSystem` is the shape that fits, and it belongs
with that option rather than with the messaging work that built the mechanism.

Until then, `pi-auto-mode` does not disarm on the strength of a registration it
cannot confirm was activated. With `delegated` true it stops classifying on
`tool_call`, because the chain link would classify the same ask a second time,
but it keeps running the deterministic **deny** list there. A deny costs no
model call, so the duplication is free, and it means a forgotten
`authorizerChain` entry costs the classifier rather than the operator's deny
rules.
