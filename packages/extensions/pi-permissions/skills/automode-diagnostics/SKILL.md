---
name: automode-diagnostics
description: Diagnose unexpected pi-automode decisions from active state, effective rules, and observability logs. Use when auto mode blocks a safe action, allows an unsafe action, or needs a narrowly scoped rule correction.
---

# Automode diagnostics

Use this skill to investigate a pi-automode decision. Read [Agent diagnostics](../../docs/auto/diagnostics.md), [Classifier flow](../../docs/auto/automode-classifier-flow.md), [Defaults](../../docs/auto/defaults.md), and [Observability logging](../../docs/auto/observability-logging.md) before you change configuration.

## Safety rules

- Investigate before you edit configuration.
- Do not evade a denial with another tool, path, or disabled safety control.
- Do not weaken a rule only to make one action pass.
- Do not print credentials, tokens, private keys, signed URLs, or sensitive tool input.
- Preserve unrelated working-tree and configuration changes.
- Do not run an unsafe rejected action because auto mode is off.

`automode_inspect` is read-only. It cannot change auto mode or configuration. Its output is model-visible and omits denial reasons and action payloads. Treat truncated output as incomplete.

## Investigation

1. Call `automode_inspect` with `status`, `config`, and `denials`.
2. Read the reported log path only when observability logging is enabled.
3. Use the denial timestamp, enforcement kind, and tool name to locate the relevant decision entry.
4. Inspect a decision reason only after you verify that it cannot contain sensitive input.
5. Identify the enforcement layer before you propose a change:
   - `permissions.deny` and `permissions.ask` are local rules.
   - `deterministic-hard-deny` is extension code.
   - `read-only` is a local allow.
   - `classifier` is a model decision.
6. Do not tune classifier rules to solve a permission or deterministic denial.

For a classifier decision, use the effective configuration and the logged classifier metadata when available. Do not dump full prompts or raw responses. They can contain session context and tool input.

## Configuration correction

Only change configuration when the user explicitly requests a correction.

1. Explain the proposed narrow change.
2. Ask the user to run `/permissions auto off`.
3. Wait for confirmation.
4. While auto mode is off, edit only the requested automode configuration and related evidence files.
5. Validate JSON syntax and the exact diff.
6. Ask the user to run `/permissions auto reload` and then `/permissions auto on`.
7. Call `automode_inspect` with `status` and `config` to confirm that auto mode is enabled and the new configuration is active.
8. Retry an action only when the user requested it and the action is safe.

When a correction replaces a rule list, check whether it retains `$defaults`. Keep unrelated protections. Test the corrected non-secret case, the secret-bearing variant, an unapproved destination, and an unrelated hard-deny case.

## Report

Report:

- the active configuration and log paths;
- the decision timestamp, ID, and enforcement layer;
- the evidence for the decision;
- the proposed or applied narrow change;
- validation performed and expected regression cases;
- remaining uncertainty; and
- whether auto mode is enabled.

If the session ends while auto mode is off, tell the user to run `/permissions auto on`.
