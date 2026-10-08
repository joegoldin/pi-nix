/**
 * Outcome of a single permission gate evaluation.
 *
 * `interrupted` (pi-nix patch) marks a block nobody ruled on: the user stopped
 * the turn to give guidance before the deciding link did. The call is blocked
 * all the same; the mark is what lets the session audit count it apart from a
 * refusal.
 */
export type GateOutcome =
  | { action: "allow" }
  | { action: "block"; reason: string; interrupted?: true };

/** Pre-validated context shared across all gates. */
export interface ToolCallContext {
  toolName: string;
  agentName: string | null;
  input: unknown;
  toolCallId: string;
  cwd: string;
}
