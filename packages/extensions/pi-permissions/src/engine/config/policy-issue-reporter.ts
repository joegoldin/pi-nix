/**
 * policy-issue-reporter.ts — Tell the operator what composing their policy
 * revealed, once per notice, for as long as it holds.
 *
 * The policy side answers only what it alone knows: the fail-closed notice for
 * a rejected non-global scope (its `allow` rules are clamped to `ask`) and the
 * port notice for relocated MCP tool keys. A config file's own schema errors
 * are `ConfigIssueReporter`'s; both reporters reading them showed the operator
 * each one twice (#953).
 *
 * Policy is re-read from file mtimes whenever it is consulted, so a file broken
 * mid-session is clamped mid-session. Reporting only at `session_start` left
 * that clamp unexplained; this is driven there and on every
 * `before_agent_start`, so the operator hears about it on the next turn.
 *
 * The notices are agent-scoped, so the agent name is an argument rather than
 * something this reads for itself: `AgentPrepHandler` resolves it from the
 * `<active_agent>` prompt tag — the only name a pi-subagents child has — after
 * turn prep runs, and hands it here.
 *
 * The latch is `ConfigIssueReporter`'s: per notice, delivered as one joined
 * message per report, and *replaced* each report rather than added to — so a
 * file fixed and broken again, or an agent switched away from and back into
 * with a broken scope, is announced again.
 */

import type { ConfigIssueWarner } from "./config-issue-reporter";

/** The policy seam this reads (ISP): the notices composing an agent's policy produced. */
export interface PolicyIssueSource {
  getPolicyIssues(agentName?: string): readonly string[];
}

/** The seam the session-start and agent-prep handlers drive. */
export interface PolicyIssueReporting {
  report(agentName: string | undefined): void;
}

export class PolicyIssueReporter implements PolicyIssueReporting {
  private reported: ReadonlySet<string> = new Set();

  constructor(
    private readonly source: PolicyIssueSource,
    private readonly log: ConfigIssueWarner,
  ) {}

  report(agentName: string | undefined): void {
    const current = this.source.getPolicyIssues(agentName);
    const unreported = current.filter((issue) => !this.reported.has(issue));
    if (unreported.length > 0) {
      this.log.warn(unreported.join("\n"));
    }
    this.reported = new Set(current);
  }
}
