import { describe, expect, it, vi } from "vitest";

import {
  PolicyIssueReporter,
  type PolicyIssueSource,
} from "#src/config/policy-issue-reporter";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * A source keyed by agent name whose answers can be reassigned between
 * reports, modeling a policy file broken or fixed mid-session. The `undefined`
 * key stands for "no agent", answered from `NO_AGENT`.
 */
function makeSource(initial: Record<string, readonly string[]> = {}) {
  let issues = initial;
  const getPolicyIssues = vi.fn<PolicyIssueSource["getPolicyIssues"]>(
    (agentName) => issues[agentName ?? NO_AGENT] ?? [],
  );
  return {
    getPolicyIssues,
    setIssues(next: Record<string, readonly string[]>): void {
      issues = next;
    },
  };
}

function makeReporter(initial: Record<string, readonly string[]> = {}) {
  const source = makeSource(initial);
  const log = { warn: vi.fn<(message: string) => void>() };
  return { reporter: new PolicyIssueReporter(source, log), source, log };
}

const NO_AGENT = "<none>";
const CLAMP = "Invalid project configuration detected";
const PORT = "Port the mcp__ keys";
const AGENT_CLAMP = "Invalid agent configuration detected";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PolicyIssueReporter", () => {
  it("asks the source about the agent it is told to report for", () => {
    const { reporter, source } = makeReporter();
    reporter.report("reviewer");
    expect(source.getPolicyIssues).toHaveBeenCalledExactlyOnceWith("reviewer");
  });

  describe("a first report", () => {
    it("warns the one notice the source answers", () => {
      const { reporter, log } = makeReporter({ [NO_AGENT]: [CLAMP] });
      reporter.report(undefined);
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(CLAMP);
    });

    it("warns several notices as one message, newline-joined", () => {
      const { reporter, log } = makeReporter({ [NO_AGENT]: [CLAMP, PORT] });
      reporter.report(undefined);
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(`${CLAMP}\n${PORT}`);
    });

    it("says nothing when composing policy revealed nothing", () => {
      const { reporter, log } = makeReporter();
      reporter.report(undefined);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe("a repeated report", () => {
    it("does not re-warn a notice that has not changed", () => {
      const { reporter, log } = makeReporter({ [NO_AGENT]: [CLAMP] });
      reporter.report(undefined);
      reporter.report(undefined);
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(CLAMP);
    });

    it("warns only the notice that newly appeared", () => {
      const { reporter, source, log } = makeReporter({ [NO_AGENT]: [CLAMP] });
      reporter.report(undefined);
      source.setIssues({ [NO_AGENT]: [CLAMP, PORT] });
      reporter.report(undefined);
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenLastCalledWith(PORT);
    });

    it("warns again a policy file fixed and then broken again", () => {
      const { reporter, source, log } = makeReporter({ [NO_AGENT]: [CLAMP] });
      reporter.report(undefined);
      source.setIssues({});
      reporter.report(undefined);
      source.setIssues({ [NO_AGENT]: [CLAMP] });
      reporter.report(undefined);
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenLastCalledWith(CLAMP);
    });

    it("warns again on switching back into an agent whose scope is broken", () => {
      const { reporter, log } = makeReporter({ reviewer: [AGENT_CLAMP] });
      reporter.report("reviewer");
      reporter.report("builder");
      reporter.report("reviewer");
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenLastCalledWith(AGENT_CLAMP);
    });
  });
});
