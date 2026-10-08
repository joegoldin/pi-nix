// The two engines joined: auto mode as a link on the permission system's
// authorizer chain, with its deterministic checks in front of the chain, and
// this setup's changes to both (search redaction, interrupt, ask-on-block, the
// listed-hard-deny classifier prompt). Moved from pi-nix's
// pi-automode-permission-chain check, which ran the same cases against the two
// packages side by side.
import { test, expect } from "bun:test";
const { withPermissionChain, getPermissionsService, DETERMINISTIC_ONLY } = await import(
  `./auto/permission-chain.ts`
);
const { publishPermissionsService, unpublishPermissionsService } = await import(
  `./engine/service.ts`
);
const { deterministicHardDeny } = await import(
  `./auto/hard-deny.ts`
);

function service() {
  const links = new Map();
  return {
    links,
    registerAuthorizer(name, authorize) {
      if (links.has(name)) throw new Error("duplicate");
      links.set(name, authorize);
      return () => links.delete(name);
    },
  };
}

function host(id = "parent", globals = globalThis) {
  const handlers = new Map();
  const channels = new Map();
  const calls = [];
  let answer;
  const ctx = {
    cwd: "/tmp/project", hasUI: false,
    sessionManager: { getSessionId: () => id },
  };
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    events: { on: (name, fn) => channels.set(name, fn) },
    appendEntry() {},
  };
  withPermissionChain((api) => api.on("tool_call", (event) => {
    if (event[DETERMINISTIC_ONLY]) {
      const reason = deterministicHardDeny(event.toolName, event.input, ctx.cwd);
      return reason ? { block: true, reason } : undefined;
    }
    calls.push(event);
    if (answer instanceof Error) throw answer;
    return answer;
  }), {
    global: globals,
    readActivation: () => ({ active: true }),
  })(pi);
  return {
    calls,
    answer: (value) => { answer = value; },
    session: (value) => { id = value; },
    emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
    ready: (sessionId) => channels.get("permissions:ready")?.({ sessionId }),
  };
}

const event = {
  toolName: "bash", toolCallId: "git-status",
  input: { command: "git status --short --branch && git log -1 --format='%h %s' && git diff --stat && git diff --cached --stat" },
};
const details = { toolName: "bash", toolCallId: event.toolCallId, surface: "bash", command: "git status --short --branch" };
const log = { review() {}, debug() {} };

test("actual package publisher connects the Git approval to the chain", async () => {
  const h = host();
  const s = service();
  try {
    await h.emit("session_start");
    publishPermissionsService("parent", s);
    h.ready("parent");
    h.ready("parent");
    expect(s.links.size).toBe(1);
    expect(await h.emit("tool_call", event)).toBeUndefined();
    expect(h.calls).toHaveLength(0);
    const authorize = s.links.get("pi-automode");
    expect(await authorize(details, {}, log)).toEqual({ kind: "allow" });
    expect(h.calls).toEqual([event]);
    for (const toolName of ["read", "write"]) {
      expect(await authorize({
        toolName, toolCallId: "projected-" + toolName,
        surface: toolName, path: "/tmp/project/file.txt",
      }, {}, log)).toEqual({ kind: "allow" });
      expect(h.calls.at(-1).input).toEqual({ path: "/tmp/project/file.txt" });
    }
    h.answer({ block: true, reason: "denied" });
    expect(await authorize(details, {}, log)).toEqual({ kind: "deny", reason: "denied" });
    h.answer(new Error("classifier failed"));
    expect(await authorize(details, {}, log)).toEqual({ kind: "defer" });
  } finally {
    await h.emit("session_shutdown");
    unpublishPermissionsService("parent", s);
  }
  expect(s.links.size).toBe(0);
});

test("publication before session_start, replacement, switch, and child isolation", async () => {
  const parent = service(), child = service(), replacement = service();
  publishPermissionsService("parent", parent);
  publishPermissionsService("child", child);
  const h = host();
  try {
    h.ready("child");
    expect(child.links.size).toBe(0);
    await h.emit("session_start");
    expect(parent.links.size).toBe(1);
    h.ready("child");
    expect(child.links.size).toBe(0);
    publishPermissionsService("parent", replacement);
    h.ready("parent");
    expect(parent.links.size).toBe(0);
    expect(replacement.links.size).toBe(1);
    h.session("child");
    await h.emit("tool_call", event);
    expect(replacement.links.size).toBe(0);
    expect(child.links.size).toBe(1);
    unpublishPermissionsService("child", child);
    await h.emit("tool_call", event);
    expect(child.links.size).toBe(0);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.emit("session_shutdown");
    unpublishPermissionsService("parent", replacement);
    unpublishPermissionsService("child", child);
  }
});

test("legacy service and standalone mode remain supported", async () => {
  const s = service();
  const h = host("parent", { [Symbol.for("@gotgenes/pi-permission-system:service")]: s });
  expect(s.links.size).toBe(1);
  await h.emit("session_start");
  await h.emit("tool_call", event);
  expect(h.calls).toHaveLength(0);
  await h.emit("session_shutdown");
  expect(s.links.size).toBe(0);
  const standalone = host("parent", {});
  standalone.answer({ block: true, reason: "denied" });
  expect(await standalone.emit("tool_call", event)).toEqual({ block: true, reason: "denied" });
});

test("keyed services never fall back to a legacy or different session", () => {
  const s = service();
  const globals = {
    [Symbol.for("@gotgenes/pi-permission-system:service")]: s,
    [Symbol.for("@gotgenes/pi-permission-system:session-services")]: new Map([["other", s]]),
  };
  expect(getPermissionsService(globals, "missing")).toBeUndefined();
  expect(getPermissionsService(globals)).toBeUndefined();
});

test("two live sessions register and shut down independently", async () => {
  const parent = service(), child = service();
  publishPermissionsService("parent", parent);
  publishPermissionsService("child", child);
  const p = host("parent"), c = host("child");
  try {
    await p.emit("session_start");
    await c.emit("session_start");
    await p.emit("session_shutdown");
    expect(parent.links.size).toBe(0);
    expect(child.links.size).toBe(1);
    await c.emit("tool_call", event);
    expect(await child.links.get("pi-automode")(details, {}, log)).toEqual({ kind: "allow" });
    expect(p.calls).toHaveLength(0);
    expect(c.calls).toHaveLength(1);
  } finally {
    await p.emit("session_shutdown");
    await c.emit("session_shutdown");
    unpublishPermissionsService("parent", parent);
    unpublishPermissionsService("child", child);
  }
});

test("failed registration retains the standalone gate and retries", async () => {
  const s = service();
  const register = s.registerAuthorizer;
  s.registerAuthorizer = () => { throw new Error("unavailable"); };
  publishPermissionsService("parent", s);
  const h = host();
  try {
    await h.emit("session_start");
    h.answer({ block: true, reason: "denied" });
    expect(await h.emit("tool_call", event)).toEqual({ block: true, reason: "denied" });
    s.registerAuthorizer = register;
    h.ready("parent");
    expect(s.links.size).toBe(1);
    const denied = { ...event, input: { command: "echo bad >> ~/.bashrc" } };
    expect((await h.emit("tool_call", denied))?.block).toBe(true);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.emit("session_shutdown");
    unpublishPermissionsService("parent", s);
  }
});

const { createPiAutomode } = await import(
  `./auto/extension.ts`
);
const { parseToolPattern } = await import(
  `./auto/permissions.ts`
);

async function realHost(configForTrust, classifyAction, ctxOverrides = {}) {
  const handlers = new Map();
  const commands = new Map();
  let state;
  const s = service();
  const globals = { [Symbol.for("@gotgenes/pi-permission-system:service")]: s };
  let classifierCalls = 0;
  const config = {
    enabled: true, classifyReadOnlyTools: false, allowInsideWorkingDirectory: true,
    deniedPaths: [], protectedPaths: [], permissionDeny: [], permissionAsk: [],
    permissionAllow: [], environment: [], allow: [], softDeny: [], hardDeny: [],
    log: { enabled: false, classifierIo: false },
  };
  const emitted = [];
  const ctx = {
    cwd: "/tmp/project", hasUI: false, isProjectTrusted: () => true,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => "real", getEntries: () => [] },
    ...ctxOverrides,
  };
  const pi = {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    events: { on() {}, emit(channel, data) { emitted.push({ channel, ...data }); } },
    appendEntry(name, data) {
      if (name === "pi-automode-state") state = structuredClone(data);
    },
    registerTool() {},
    registerCommand(name, command) { commands.set(name, command); },
    getAllTools: () => [],
  };
  withPermissionChain(createPiAutomode({
    loadConfig: (_cwd, trusted) => ({ ...config, ...configForTrust(trusted) }),
    classifyAction: async (...args) => {
      classifierCalls++;
      if (classifyAction) return classifyAction(...args);
      throw new Error("deterministic pre-pass must not call the classifier");
    },
  }), { global: globals, readActivation: () => ({ active: true }) })(pi);
  const emit = async (name, event = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? []) {
      result = await handler(event, ctx);
      if (result?.block) return result;
    }
    return result;
  };
  await emit("session_start");
  return { emit, commands, ctx, service: s, emitted, classifierCalls: () => classifierCalls, state: () => state };
}

test("real upstream gate denies compound Bash before a permission-system allow", async () => {
  const h = await realHost(() => ({ permissionDeny: [parseToolPattern("bash(curl *)")] }));
  const result = await h.emit("tool_call", {
    ...event, input: { command: "echo ready; curl https://example.com" },
  });
  expect(result?.block).toBe(true);
  expect(result.reason).toContain("permissions.deny");
  expect(h.classifierCalls()).toBe(0);
  expect(h.state().checkedActions).toBe(1);
  expect(h.state().blockedActions).toBe(1);
});

// pi-automode-search-redaction.patch: a recursive search whose scope can
// reach a denied path runs, and what it found there is withheld from the
// result. Blocking it instead failed every search once "*.env" was denied.
test("real upstream gate withholds denied subtrees from recursive grep and find results", async () => {
  const h = await realHost(() => ({ deniedPaths: ["/tmp/project/private/*"] }));
  const outputs = {
    grep: "src/a.ts:1: needle\nprivate/key.txt:3: needle\nprivate/key.txt-4- context",
    find: "src/a.ts\nprivate/key.txt",
  };
  for (const toolName of ["grep", "find"]) {
    const call = await h.emit("tool_call", {
      toolName, toolCallId: toolName, input: { path: ".", pattern: "*" },
    });
    expect(call?.block).toBeUndefined();
    const result = await h.emit("tool_result", {
      toolName, toolCallId: toolName,
      content: [{ type: "text", text: outputs[toolName] }],
    });
    const text = result.content[0].text;
    expect(text).toContain("src/a.ts");
    expect(text).not.toContain("private/key.txt");
    expect(text).toMatch(/\[\d+ result lines under paths denied by policy were withheld\]/);
    expect(result.structuredContent).toBeUndefined();
  }
  expect(h.classifierCalls()).toBe(0);
});

test("real pre-pass uses trusted project configuration and live session overrides", async () => {
  const h = await realHost((trusted) => ({
    permissionDeny: trusted ? [parseToolPattern("bash(curl *)")] : [],
  }));
  const denied = { ...event, input: { command: "curl https://example.com" } };
  expect((await h.emit("tool_call", denied))?.block).toBe(true);
  await h.commands.get("automode").handler("off", h.ctx);
  expect(await h.emit("tool_call", denied)).toBeUndefined();
  await h.commands.get("automode").handler("on", h.ctx);
  expect((await h.emit("tool_call", denied))?.block).toBe(true);
  expect(h.classifierCalls()).toBe(0);
});

test("real pre-pass leaves an allowed action for the permission system without classification", async () => {
  const h = await realHost(() => ({}));
  expect(await h.emit("tool_call", event)).toBeUndefined();
  expect(h.classifierCalls()).toBe(0);
});

// pi-automode-interrupt.patch: Esc with messages queued interrupts the turn to
// send them, and pi-custom marks that abort on globalThis while it settles. A
// check auto mode was making then still stops the tool, but is not counted or
// reported as a denial. A plain Esc is a cancel, handled as upstream does.
const STEERING = Symbol.for("pi-custom.steering");

test("an interruption to steer, before the check, blocks without recording a denial", async () => {
  const h = await realHost(() => ({}));
  h.ctx.signal = AbortSignal.abort();
  globalThis[STEERING] = true;
  try {
    const result = await h.emit("tool_call", event);
    expect(result?.block).toBe(true);
    expect(result.reason).toContain("This was not a denial");
    expect(h.state()?.blockedActions ?? 0).toBe(0);
    expect(h.state()?.recentDenials ?? []).toEqual([]);
  } finally {
    delete globalThis[STEERING];
  }
});

test("a plain Esc still cancels as a block", async () => {
  const h = await realHost(() => ({}));
  h.ctx.signal = AbortSignal.abort();
  const result = await h.emit("tool_call", event);
  expect(result?.block).toBe(true);
  expect(result.reason).toContain("Cancelled");
  expect(h.state().blockedActions).toBe(1);
});

test("an interruption to steer while the classifier decides blocks without recording a denial", async () => {
  const failed = { decision: "block", tier: "none", reason: "Fast classifier failed; auto mode fails closed: The operation was aborted." };
  const interrupted = async (steer) => {
    const controller = new AbortController();
    const h = await realHost(() => ({ allowInsideWorkingDirectory: false }), async () => {
      controller.abort();
      return failed;
    });
    h.ctx.signal = controller.signal;
    if (steer) globalThis[STEERING] = true;
    try {
      expect(await h.emit("tool_call", event)).toBeUndefined();
      const verdict = await h.service.links.get("pi-automode")(details, {}, log);
      expect(h.classifierCalls()).toBe(1);
      return { kind: verdict.kind, reason: verdict.reason, blocked: h.state()?.blockedActions ?? 0 };
    } finally {
      delete globalThis[STEERING];
    }
  };
  const steered = await interrupted(true);
  expect(steered.kind).toBe("interrupted");
  expect(steered.reason).toContain("This was not a denial");
  expect(steered.blocked).toBe(0);
  const cancelled = await interrupted(false);
  expect(cancelled.kind).toBe("deny");
  expect(cancelled.reason).toContain("auto mode fails closed");
  expect(cancelled.blocked).toBe(1);
});

// pi-permission-system-interrupt.patch: the permission system records the
// link's `interrupted` verdict as an interruption everywhere it would have
// recorded a denial: review log, decision event, forwarded decider, and the
// reason the agent reads.
const { composeAuthorizerChain } = await import(
  `./engine/authority/authorizer-chain.ts`
);
const { PermissionPrompter } = await import(
  `./engine/authority/permission-prompter.ts`
);
const { resolutionFor } = await import(
  `./engine/authority/decision-resolution.ts`
);
const { asDecisionSource, wasInterrupted } = await import(
  `./engine/authority/decision-source.ts`
);
const { asPromptPayload } = await import(
  `./engine/presentation/prompt-payload.ts`
);
const { renderRefusal } = await import(
  `./engine/presentation/agent-renderer.ts`
);

test("the permission system records an interrupted verdict as an interruption, not a denial", async () => {
  const payload = asPromptPayload({
    kind: "bash",
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: "bash", toolName: "bash", invokedToolName: null, value: "git status",
      matchedPattern: null, matchedSpelling: null, commandContext: null, executedUnit: null,
    },
    evidence: [],
    annotations: [],
  });
  expect(payload).toBeDefined();
  const reviews = [];
  const prompter = new PermissionPrompter({ logger: { review: (event, entry) => reviews.push({ event, ...entry }), debug() {} } });
  const decide = (verdict) => prompter.prompt(
    composeAuthorizerChain(
      [{ name: "pi-automode", authorize: async () => verdict }],
      { authorize: async () => { throw new Error("an interruption must not reach the prompt"); } },
      {},
      log,
    ),
    { requestId: "r1", source: "tool_call", agentName: null, payload, toolCallId: "c1", toolName: "bash" },
  );

  const decision = await decide({ kind: "interrupted", reason: "steering" });
  expect(decision.approved).toBe(false);
  expect(decision.decidedBy).toEqual({ kind: "authorizer", name: "pi-automode", verdict: "interrupted", reason: "steering" });
  expect(reviews.at(-1).event).toBe("permission_request.interrupted");
  expect(reviews.at(-1).resolution).toBe("interrupted");
  expect(resolutionFor(decision.decidedBy, { approved: false, forSession: false })).toBe("interrupted");
  // A forwarded response keeps the verdict, so the requesting session records it too.
  const forwarded = asDecisionSource({ kind: "forwarded", responderSessionId: null, decision: decision.decidedBy });
  expect(wasInterrupted(forwarded)).toBe(true);
  const reason = renderRefusal(payload, decision.decidedBy, null);
  expect(reason).toContain("The user interrupted the turn");
  expect(reason).toContain("Nothing was denied");
  expect(reason).not.toContain("authorizer denied");

  const denied = await decide({ kind: "deny", reason: "no" });
  expect(reviews.at(-1).event).toBe("permission_request.denied");
  expect(resolutionFor(denied.decidedBy, { approved: false, forSession: false })).toBe("authorizer_denied");
  expect(renderRefusal(payload, denied.decidedBy, denied.denialReason ?? null)).toContain("authorizer denied");
});

test("the session audit counts an interrupted call apart from blocks", async () => {
  const { createFailClosedToolCall } = await import(
    `./engine/handlers/tool-call-boundary.ts`
  );
  const { DecisionAudit } = await import(
    `./engine/logging/decision-audit.ts`
  );
  const audit = new DecisionAudit();
  const outcomes = [
    { action: "allow" },
    { action: "block", reason: "refused" },
    { action: "block", reason: "stopped", interrupted: true },
  ];
  const traces = [];
  const toolCall = createFailClosedToolCall(
    async () => outcomes.shift(),
    { writeReviewLog() {}, emitDecision() {} },
    audit,
    { debug: (event, details) => traces.push(details) },
  );
  expect(await toolCall({ toolName: "bash" }, {})).toEqual({});
  expect(await toolCall({ toolName: "bash" }, {})).toEqual({ block: true, reason: "refused" });
  // Interrupted, the call is still blocked.
  expect(await toolCall({ toolName: "bash" }, {})).toEqual({ block: true, reason: "stopped" });
  expect(traces.map((t) => t.action)).toEqual(["allow", "block", "interrupted"]);
  const summaries = [];
  const warnings = [];
  audit.writeSummary({ debug: (event, counts) => summaries.push(counts), warn: (m) => warnings.push(m) });
  expect(summaries).toEqual([{ toolCalls: 3, allowed: 1, blocked: 1, interrupted: 1, errors: 0 }]);
  expect(warnings).toEqual([]);
});

// What a session with a UI offers besides the prompt: auto mode keeps its
// status slot up to date.
const statusUi = { notify() {}, setStatus() {}, theme: { fg: (_slot, text) => text } };

/**
 * A terminal UI whose `custom` mounts the dialog it is handed and lets the
 * test press keys in it, as the user would.
 */
function terminalUi() {
  const mounted = [];
  const ui = {
    ...statusUi,
    custom: (factory) =>
      new Promise((resolve) => {
        const component = factory({ requestRender() {} }, { fg: (_slot, text) => text, bold: (text) => text }, {}, resolve);
        mounted.push(component);
      }),
  };
  return { ui, mounted, press: (key) => mounted.at(-1).handleInput(key) };
}

// ask-on-block: with askOnBlock on, a classifier block asks first, in the
// terminal UI. Allow runs the call; Deny or Esc refuses it; no answer in time
// keeps the block, and says so, so a later go-ahead can clear it.
test("a classifier block asks first, and the answer decides", async () => {
  const blocked = { decision: "block", tier: "soft_deny", reason: "Writes a secret." };
  const run = async (answer, toolCallId) => {
    const term = terminalUi();
    const h = await realHost(
      () => ({ allowInsideWorkingDirectory: false, askOnBlock: { enabled: true, timeoutSeconds: 1 } }),
      async () => blocked,
      { hasUI: true, mode: "tui", ui: term.ui },
    );
    await h.emit("tool_call", { ...event, toolCallId });
    const pending = h.service.links.get("pi-automode")({ ...details, toolCallId }, {}, log);
    // The dialog mounts once the classifier has answered.
    while (term.mounted.length === 0) await new Promise((r) => setTimeout(r, 5));
    if (answer) term.press(answer);
    return { h, term, verdict: await pending };
  };

  const allowed = await run("y", "ask-allow");
  expect(allowed.verdict).toEqual({ kind: "allow" });
  const shown = allowed.term.mounted[0].render(80).join("\n");
  expect(shown).toContain("Writes a secret.");
  expect(shown).toContain("No answer in 1s keeps the block");
  expect(allowed.h.emitted.map((e) => e.channel)).toEqual(["permissions:ui_prompt", "permissions:decision"]);
  expect(allowed.h.emitted[0].requestId).toBe(allowed.h.emitted[1].requestId);
  // A second request for the same call does not ask again.
  expect(await allowed.h.service.links.get("pi-automode")({ ...details, toolCallId: "ask-allow" }, {}, log)).toEqual({ kind: "allow" });
  expect(allowed.term.mounted).toHaveLength(1);

  const denied = await run("n", "ask-deny");
  expect(denied.verdict.kind).toBe("deny");
  expect(denied.verdict.reason).toContain("The user was asked and denied it.");

  const unanswered = await run(undefined, "ask-timeout");
  expect(unanswered.verdict.kind).toBe("deny");
  expect(unanswered.verdict.reason).toContain("did not answer within 1s");
  expect(unanswered.h.state().blockedActions).toBe(1);
});

test("a classifier block does not ask with askOnBlock off, no UI, or headless", async () => {
  const blocked = { decision: "block", tier: "soft_deny", reason: "Writes a secret." };
  for (const [askOnBlock, ctx] of [
    [{ enabled: false }, { hasUI: true, mode: "tui" }],
    [{ enabled: true }, { hasUI: false }],
    // A headless session with a UI surface (RPC, print, a subagent) has no one
    // watching to answer.
    [{ enabled: true }, { hasUI: true, mode: "rpc" }],
    [{ enabled: true }, { hasUI: true, mode: "print" }],
  ]) {
    const term = terminalUi();
    const h = await realHost(() => ({ allowInsideWorkingDirectory: false, askOnBlock }), async () => blocked, { ...ctx, ui: term.ui });
    await h.emit("tool_call", event);
    expect((await h.service.links.get("pi-automode")(details, {}, log)).kind).toBe("deny");
    expect(term.mounted).toHaveLength(0);
  }
});

// listed-hard-deny: the classifier is told only listed hard-deny rules are
// unconditional, and no example labels its own tier.
test("the classifier prompt takes the tier from the listed rules only", async () => {
  const { CLASSIFIER_SYSTEM_PROMPT } = await import("./auto/constants.ts");
  expect(CLASSIFIER_SYSTEM_PROMPT).toContain("Only the rules listed under HARD_DENY below are hard_deny");
  expect(CLASSIFIER_SYSTEM_PROMPT).not.toMatch(/=> block, hard_deny/);
});
