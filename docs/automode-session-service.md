# Permission-service compatibility

The pi-automode fork at `v1.11.0-jg.4` expects the legacy process-global
permission service. The pinned permission system, 32.0.2, publishes services
by session ID instead. Without the compatibility patch, Auto mode runs its
standalone classifier but never registers with the permission system; an
approved command still reaches a manual prompt with
`authorizer_chain_unregistered_link` in the review log.

`packages/extensions/pi-automode-session-service.patch` adapts the fork at
build time. It selects the service using the current Pi context's session ID,
retries after publication, replaces registrations when the service or session
changes, and unregisters on shutdown. Ready events from other sessions cannot
redirect the registration. Legacy services remain supported when there is no
session registry. Classification and deny rules are unchanged.

Run `nix build .#checks.x86_64-linux.pi-automode-permission-chain` to test the
packaged adapter against the pinned permission system's actual publisher.
The check covers the original compound Git command, both publication orders,
service replacement, session switches, simultaneous sessions, cleanup,
registration failures, and allow/deny/defer behavior. Its classifier is a
deterministic test double, so it requires neither credentials nor a model API.

When updating the fork, upstream this compatibility change and remove the
patch once the pinned source contains it. Keep the cross-package check: the
dependency update from 27.0.0 to 32.0.2 exposed a contract mismatch that tests
of either extension alone did not catch.
