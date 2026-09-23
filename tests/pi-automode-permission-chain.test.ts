import { test, expect } from "bun:test";
const { withPermissionChain, getPermissionsService, DETERMINISTIC_ONLY } = await import(
  `${process.env.AUTOMODE_PACKAGE}/extensions/auto-mode/permission-chain.ts`
);
const { publishPermissionsService, unpublishPermissionsService } = await import(
  `${process.env.PERMISSION_PACKAGE}/src/service.ts`
);
const { deterministicHardDeny } = await import(
  `${process.env.AUTOMODE_PACKAGE}/extensions/auto-mode/hard-deny.ts`
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
  `${process.env.AUTOMODE_PACKAGE}/extensions/auto-mode/extension.ts`
);
const { parseToolPattern } = await import(
  `${process.env.AUTOMODE_PACKAGE}/extensions/auto-mode/permissions.ts`
);

async function realHost(configForTrust) {
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
  const ctx = {
    cwd: "/tmp/project", hasUI: false, isProjectTrusted: () => true,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => "real", getEntries: () => [] },
  };
  const pi = {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    events: { on() {} },
    appendEntry(name, data) {
      if (name === "pi-automode-state") state = structuredClone(data);
    },
    registerTool() {},
    registerCommand(name, command) { commands.set(name, command); },
    getAllTools: () => [],
  };
  withPermissionChain(createPiAutomode({
    loadConfig: (_cwd, trusted) => ({ ...config, ...configForTrust(trusted) }),
    classifyAction: async () => {
      classifierCalls++;
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
  return { emit, commands, ctx, classifierCalls: () => classifierCalls, state: () => state };
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

test("real upstream gate protects denied subtrees from recursive grep and find", async () => {
  const h = await realHost(() => ({ deniedPaths: ["/tmp/project/private/*"] }));
  for (const toolName of ["grep", "find"]) {
    const result = await h.emit("tool_call", {
      toolName, toolCallId: toolName, input: { path: ".", pattern: "*" },
    });
    expect(result?.block).toBe(true);
    expect(result.reason).toContain("Search scope");
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
