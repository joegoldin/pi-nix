# ADR-002: Store the global config in the extension data directory

**Date:** 2026-08-25

## Context

Pi-automode stores its global configuration at `~/.pi/agent/automode.json`. The extension stores application-owned logs below `~/.pi/agent/extensions/pi-automode/logs/`.

The separate global configuration path makes extension-owned data harder to identify and manage. The global configuration belongs beside the existing log directory.

An existing installation can contain the legacy file. Migration must not discard configuration data or create different read and write sources.

This decision refines the global user-owned configuration source from [ADR-001](ADR-001-permission-precedence-and-trust-boundaries.md). It does not change permission precedence or project trust boundaries.

Tracking issue: [#27](https://github.com/czottmann/pi-automode/issues/27)

## Decision

Pi-automode stores the global configuration at:

```text
~/.pi/agent/extensions/pi-automode/config.json
```

The existing log directory stays at:

```text
~/.pi/agent/extensions/pi-automode/logs/
```

Project configuration files keep their current paths and semantics:

- `.pi/automode.local.json`
- `.pi/automode.json`

At startup, pi-automode selects one active global configuration path for the session:

1. If only the new file is present, pi-automode uses the new file.
2. If only the legacy file is present, pi-automode moves it to the new path before loading configuration.
3. If the two files are present, pi-automode uses the new file and does not change the legacy file.
4. If migration fails, pi-automode uses the legacy file for reads and writes during that session.
5. If neither file is present, pi-automode uses the new path for the next write.

Pi-automode attempts migration once per session. A later session retries a failed migration.

A successful migration produces one UI notification. A path conflict produces a warning during every startup. A migration error produces one warning per session.

Conflict and migration error details also appear in configuration diagnostics. This behavior makes the details available in headless sessions.

## Consequences

All extension-owned global data has one identifiable root directory. Configuration backups and extension cleanup become easier to understand.

The new configuration inherits the deterministic protection for `~/.pi/agent/extensions/`. Direct agent file tools cannot modify the configuration.

The extension must pass the selected active path to configuration reads and writes. This requirement prevents split-brain configuration during migration errors.

The migration is one-way. A downgraded pi-automode version does not automatically find the new configuration path.

Startup gains a small filesystem operation and migration state. Tests must cover migration, conflicts, errors, notifications, diagnostics, and unchanged project precedence.
