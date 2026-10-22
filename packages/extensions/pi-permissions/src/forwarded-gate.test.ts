import { expect, test } from "bun:test";
import { PermissionLedger } from "./denials.ts";
import { createForwardedGate } from "./forwarded-gate.ts";
import { DETERMINISTIC_ONLY } from "./auto/permission-chain.ts";

const event = { type: "tool_call", toolName: "bash", toolCallId: "call", input: { command: "bun test" } };
const details = (id = "child") => ({ toolCall: event, forwarding: { requesterSessionId: id, requesterAgentName: "worker", requesterCwd: "/tmp/child" } });
const ctx = { cwd: "/tmp/parent" } as never;

test("forwarded denials persist and exact approval applies only to the owner after deterministic checks", async () => {
  const ledger = new PermissionLedger();
  let saves = 0;
  const gate = createForwardedGate(ledger, () => saves++);
  const handler = async (call, childCtx) => {
    expect(childCtx.cwd).toBe("/tmp/child");
    return call[DETERMINISTIC_ONLY] ? undefined : { block: true, reason: "needs approval" };
  };
  await gate.wrap(handler, details())(event, ctx);
  expect(saves).toBe(1);
  expect(ledger.open()[0].owner?.sessionId).toBe("child");
  ledger.approve(ledger.open()[0].id);
  expect(await gate.wrap(handler, details())(event, ctx)).toBeUndefined();
  expect((await gate.wrap(handler, details("sibling"))(event, ctx))?.block).toBe(true);
  expect(ledger.isGranted(event.toolName, event.input)).toBe(false);
  expect((await gate.wrap(async () => ({ block: true, reason: "hard restriction" }), details())(event, ctx))?.block).toBe(true);
});

test("concurrent forwarded requests keep async ownership separate and restore parent context", async () => {
  const gate = createForwardedGate(new PermissionLedger(), () => {});
  let release;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const a = gate.wrap(async () => { await wait; expect(gate.owner()?.sessionId).toBe("a"); }, details("a"))(event, ctx);
  await gate.wrap(async () => { expect(gate.owner()?.sessionId).toBe("b"); release(); }, details("b"))(event, ctx);
  await a;
  expect(gate.owner()).toBeUndefined();
});

test("interrupted and incomplete requests never become approvals", async () => {
  const ledger = new PermissionLedger();
  const gate = createForwardedGate(ledger, () => {});
  await gate.wrap(async () => ({ block: true, reason: "User interrupted the turn" }), details())(event, ctx);
  expect(ledger.open()).toEqual([]);
  await gate.wrap(async () => ({ block: true, reason: "missing metadata" }), { forwarding: details().forwarding })(event, ctx);
  expect(ledger.approve(ledger.open()[0].id)).toBeUndefined();
  expect(ledger.grantList()).toEqual([]);
});

test("out-of-process requests reach the parent ledger through the real forwarding inbox", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createPermissionForwardingLocation } = await import("./engine/authority/permission-forwarding.ts");
  const { ForwardedRequestServer } = await import("./engine/authority/forwarded-request-server.ts");
  for (const policyState of ["deny", "ask"]) {
    const dir = mkdtempSync(join(tmpdir(), "permission-ledger-inbox-"));
    try {
      const location = createPermissionForwardingLocation(dir, "parent");
      mkdirSync(location.requestsDir, { recursive: true });
      const ledger = new PermissionLedger();
      const gate = createForwardedGate(ledger, () => {});
      const request = {
        id: "request", createdAt: Date.now(), requesterSessionId: "child", targetSessionId: "parent", requesterAgentName: "worker",
        toolCall: event, source: "tool_call", surface: "bash", value: event.input.command,
        accessIntent: { surface: "bash", matchValues: [event.input.command], boundaryValue: null, requesterCwd: "/tmp/child", principal: { sessionId: "child", agentName: "worker" } },
      };
      const writer = Bun.spawn([process.execPath, "-e", "await Bun.write(process.argv[1], process.argv[2])", join(location.requestsDir, "request.json"), JSON.stringify(request)], { stdout: "pipe", stderr: "pipe" });
      expect(await writer.exited).toBe(0);
      const server = new ForwardedRequestServer({
        forwardingDir: dir, logger: { review() {}, debug() {} },
        policy: { resolve: () => ({ state: policyState, toolName: "bash", matchedPattern: "*", origin: "user", reason: "policy denied" }) },
        escalator: { escalate: async () => ({ approved: false, state: "denied", denialReason: "classifier denied", decidedBy: { kind: "authorizer", name: "pi-automode", verdict: "deny" } }) },
        broadcaster: { emitDecision() {} }, recorder: { recordSessionApproval() {} }, onDecision: gate.recordDecision,
      } as never);
      await server.processInbox({ sessionManager: { getSessionId: () => "parent" } } as never);
      expect(JSON.parse(readFileSync(join(location.responsesDir, "request.json"), "utf8")).approved).toBe(false);
      expect(ledger.open()).toHaveLength(1);
      const denied = ledger.open()[0];
      expect(denied.input).toEqual(event.input);
      expect(denied.owner).toEqual({ sessionId: "child", agentName: "worker", cwd: "/tmp/child" });
      expect(denied.policyDenied).toBe(policyState === "deny");
      if (policyState === "deny") expect(ledger.approve(denied.id)).toBeUndefined();
      else {
        ledger.approve(denied.id);
        expect(ledger.isGranted(event.toolName, event.input, denied.owner)).toBe(true);
        expect(ledger.isGranted(event.toolName, event.input)).toBe(false);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
