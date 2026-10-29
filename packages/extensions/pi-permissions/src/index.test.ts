import { describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import piPermissions from "./index.ts";
import { PermissionLedger, type PermissionRecord } from "./denials.ts";

/** A session's event bus as pi builds it, and a pi that records what is registered. */
function session() {
	const emitter = new EventEmitter();
	const bus = {
		emit: (channel: string, data: unknown) => emitter.emit(channel, data),
		on: (channel: string, handler: (data: unknown) => unknown) => {
			const safe = async (data: unknown) => {
				await handler(data);
			};
			emitter.on(channel, safe);
			return () => emitter.off(channel, safe);
		},
	};
	const tools: string[] = [];
	const definitions = new Map<string, any>();
	const shortcuts = new Map<string, { handler: (ctx: unknown) => unknown }>();
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown; getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null }>();
	const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
	const entries: { type: string; customType: string; data: unknown }[] = [];
	const api = () =>
		({
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			events: { emit: bus.emit, on: bus.on },
			registerTool: (tool: { name: string }) => { tools.push(tool.name); definitions.set(tool.name, tool); },
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, command),
			sendMessage: (message: { customType: string; content: string }, options: unknown) => sent.push({ message, options }),
			registerShortcut: (key: string, shortcut: { handler: (ctx: unknown) => unknown }) => shortcuts.set(key, shortcut),
			registerFlag() {},
			registerMessageRenderer() {},
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools() {},
		}) as never;
	/** Run a tool call through every handler, stopping at the first block, as pi does. */
	const toolCall = async (event: unknown, ctx: unknown) => {
		for (const handler of handlers.get("tool_call") ?? []) {
			const result = (await handler(event, ctx)) as { block?: boolean; reason?: string } | undefined;
			if (result?.block) return result;
		}
		return undefined;
	};
	return { api, tools, definitions, handlers, commands, shortcuts, sent, entries, toolCall, bus };
}

describe("loading", () => {
	it("registers once per session however many times it is loaded", () => {
		const s = session();
		piPermissions(s.api());
		const once = [...s.tools];
		piPermissions(s.api());
		expect(once.length).toBeGreaterThan(0);
		expect(s.tools).toEqual(once);
	});

	it("registers in each session", () => {
		const a = session();
		const b = session();
		piPermissions(a.api());
		piPermissions(b.api());
		expect(b.tools).toEqual(a.tools);
	});
});

describe("the ledger around both halves", () => {
	it("records a block, and an approved call passes both halves after it", async () => {
		const s = session();
		piPermissions(s.api());
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			mode: "print",
			isIdle: () => true,
			ui: { notify() {}, setStatus() {} },
			sessionManager: { getEntries: () => s.entries, getSessionId: () => "s1", getSessionFile: () => undefined, getSessionDir: () => "/tmp", getBranch: () => [] },
			isProjectTrusted: () => false,
		};
		// A shell profile write: auto mode's deterministic hard deny, no model call.
		const call = { toolName: "write", toolCallId: "c1", input: { path: join(homedir(), ".bashrc"), content: "alias x=y" } };
		const blocked = await s.toolCall(call, ctx);
		expect(blocked?.block).toBe(true);
		// Headless: the agent is not told of a menu it cannot reach.
		expect(blocked?.reason).not.toContain("/permissions");
		const record = s.entries.at(-1)!.data as { denials: { toolCallId: string; state: string }[] };
		expect(record.denials).toEqual([expect.objectContaining({ toolCallId: "c1", state: "open" })]);

		await s.commands.get("permissions")!.handler("approve last", ctx);
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]!.message.content).toContain("Write(");
		expect(s.sent[0]!.options).toEqual({ triggerTurn: true });

		expect(await s.toolCall({ ...call, toolCallId: "c2" }, ctx)).toBeUndefined();
		// A different input is not covered.
		expect((await s.toolCall({ ...call, toolCallId: "c3", input: { ...call.input, content: "other" } }, ctx))?.block).toBe(true);
	});
});

describe("scoped approval lifetime", () => {
	function restoredSession() {
		const s = session();
		const ledger = new PermissionLedger();
		ledger.approveSimilar("bash", { command: "nixfmt a.nix" }, "/tmp");
		const branch = [{ type: "custom", customType: "pi-permissions", data: ledger.snapshot() }];
		const ctx = { cwd: "/tmp", sessionManager: { getBranch: () => branch } };
		piPermissions(s.api());
		s.handlers.get("session_start")!.at(-1)!({}, ctx);
		return { s, ctx, branch };
	}

	it("new operator input expires scopes, extension continuations do not", () => {
		const { s } = restoredSession();
		s.handlers.get("input")![0]!({ source: "extension" }, {});
		expect(s.entries).toHaveLength(0);
		s.handlers.get("input")![0]!({ source: "interactive" }, {});
		expect((s.entries.at(-1)!.data as PermissionRecord).grants).toEqual([]);
	});

	it("submitted questionnaire answers expire scopes through the shared event bus", () => {
		const { s } = restoredSession();
		s.bus.emit("pi-user-decision:submitted", { toolCallId: "q1" });
		expect((s.entries.at(-1)!.data as PermissionRecord).grants).toEqual([]);
	});

	it("tree navigation cannot carry a scope to a branch without that approval", () => {
		const { s, ctx, branch } = restoredSession();
		branch.length = 0;
		for (const handler of s.handlers.get("session_tree") ?? []) handler({}, ctx);
		s.handlers.get("input")![0]!({ source: "interactive" }, {});
		expect(s.entries).toHaveLength(0);
	});
});

describe("subagents", () => {
	it("makes every child of a session load pi-permissions, for every runner, and lets go at shutdown", async () => {
		const { requireInChildren } = await import("./index.ts");
		const root: Record<symbol, unknown> = {};
		const key = Symbol.for("pi-subagents.required-child-extensions.v1");
		const undo = requireInChildren("s1", root);
		const store = root[key] as { version: number; bySession: Map<string, { id: string; path: string; requireForAllRunners?: boolean }[]> };
		expect(store.version).toBe(1);
		const [entry] = store.bySession.get("s1")!;
		expect(entry).toMatchObject({ id: "pi-permissions", requireForAllRunners: true });
		expect(entry!.path).toEndWith("/src/index.ts");
		// Another host's requirement for the same session is kept.
		store.bySession.set("s1", [{ id: "other", path: "/x.ts" }, ...store.bySession.get("s1")!]);
		requireInChildren("s1", root);
		expect(store.bySession.get("s1")!.map((e) => e.id)).toEqual(["other", "pi-permissions"]);
		undo();
		expect(store.bySession.get("s1")!.map((e) => e.id)).toEqual(["other", "pi-permissions"]);
	});

	it("refuses a registry it does not understand rather than leave children ungated", async () => {
		const { requireInChildren } = await import("./index.ts");
		const root: Record<symbol, unknown> = { [Symbol.for("pi-subagents.required-child-extensions.v1")]: { version: 2 } };
		expect(() => requireInChildren("s1", root)).toThrow("unknown shape");
	});
});

describe("one menu", () => {
	it("completes nested settings commands beneath the single public entry", async () => {
		const s = session();
		piPermissions(s.api());
		const complete = s.commands.get("permissions")!.getArgumentCompletions;
		expect((await complete?.(""))?.map((item) => item.value)).toEqual(["auto", "settings", "approve last"]);
		expect(await complete?.("settings sh")).toEqual([expect.objectContaining({ value: "settings show" })]);
	});

	it("exposes only /permissions, with both menus and their subcommands under it", async () => {
		const s = session();
		piPermissions(s.api());
		const opened: string[][] = [];
		const notes: string[] = [];
		const ctx = {
			cwd: "/tmp",
			hasUI: true,
			mode: "tui",
			isIdle: () => true,
			ui: {
				notify: (message: string) => notes.push(message),
				setStatus() {},
				theme: { fg: (_slot: string, text: string) => text },
				custom: (factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }) =>
					new Promise((resolve) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 40 } },
							{ fg: (_slot: string, text: string) => text, bold: (text: string) => text },
							{},
							resolve,
						);
						opened.push(component.render(100));
						component.handleInput("\u001b");
					}),
			},
			sessionManager: { getEntries: () => s.entries, getSessionId: () => "s1", getSessionFile: () => undefined, getSessionDir: () => "/tmp", getBranch: () => [] },
			isProjectTrusted: () => false,
		};
		expect([...s.commands.keys()]).toEqual(["permissions"]);
		await s.commands.get("permissions")!.handler("auto", ctx);
		await s.commands.get("permissions")!.handler("settings", ctx);
		expect(opened).toHaveLength(2);
		// Each opens on its own tab.
		expect(opened[0]!.some((l) => l.includes("Classifier model"))).toBe(true);
		expect(opened[1]!.some((l) => l.includes("YOLO mode"))).toBe(true);
		await s.commands.get("permissions")!.handler("auto status", ctx);
		expect(opened).toHaveLength(2);
		expect(notes.some((n) => n.includes("checked actions:"))).toBe(true);
		await s.commands.get("permissions")!.handler("auto help", ctx);
		await s.commands.get("permissions")!.handler("settings help", ctx);
		expect(notes.some((n) => n.includes("Usage: /permissions auto"))).toBe(true);
		expect(notes.some((n) => n.includes("Usage: /permissions settings"))).toBe(true);
		expect(notes.join("\n")).not.toMatch(/\/(automode|auto-mode|permission-system)\b/);
	});
});

describe("menu approval reaches classifier context", () => {
	for (const key of ["\r", "a"]) it(`persists a reviewed shell scenario from ${JSON.stringify(key)}`, async () => {
		const { buildClassifierContext } = await import("./auto/classifier.ts");
		const s = session();
		const ledger = new PermissionLedger();
		const input = { command: "ssh host 'diagnose /tmp/a'", description: "Inspect the remote service." };
		ledger.record({ toolName: "bash", toolCallId: "blocked", input, reason: "Remote access needs approval." });
		s.entries.push({ type: "custom", customType: "pi-permissions", data: ledger.snapshot() });
		const ctx = {
			cwd: "/tmp", mode: "tui", hasUI: true, isIdle: () => true,
			sessionManager: { getBranch: () => s.entries },
			ui: { notify() {}, custom: (factory: Function) => new Promise((resolve) => {
				const view = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_slot: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
				view.handleInput(key);
				view.handleInput("\x1b");
			}) },
		};
		piPermissions(s.api());
		s.handlers.get("session_start")!.at(-1)!({}, ctx);
		await s.commands.get("permissions")!.handler("", ctx);
		const restored = new PermissionLedger(); restored.restore(s.entries.at(-1)!.data as PermissionRecord);
		expect(restored.open()).toEqual([]);
		expect(restored.isGranted("bash", input)).toBe(false);
		const approvals = restored.scenarioApprovals("bash", "/tmp");
		expect(approvals).toHaveLength(1);
		expect(buildClassifierContext("", "", approvals)).toContain("ssh host 'diagnose /tmp/a'");
		expect(s.sent[0]!.message.content).toContain("variants are reviewed by the auto classifier");
		s.handlers.get("input")![0]!({ source: "interactive" }, ctx);
		const expired = new PermissionLedger(); expired.restore(s.entries.at(-1)!.data as PermissionRecord);
		expect(expired.scenarioApprovals("bash", "/tmp")).toEqual([]);
	});
});

for (const expanded of [false, true]) it(`capital A grants exact session access without classifier scope (${expanded ? "expanded" : "list"})`, async () => {
	const s = session();
	const ledger = new PermissionLedger();
	const input = { command: "ssh host 'diagnose /tmp/a'" };
	ledger.record({ toolName: "bash", toolCallId: "blocked", input, reason: "Remote access needs approval." });
	s.entries.push({ type: "custom", customType: "pi-permissions", data: ledger.snapshot() });
	const ctx = {
		cwd: "/tmp", mode: "tui", hasUI: true, isIdle: () => true,
		sessionManager: { getBranch: () => s.entries },
		ui: { notify() {}, custom: (factory: Function) => new Promise((resolve) => {
			const view = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_slot: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
			if (expanded) view.handleInput("e");
			view.handleInput("A"); view.handleInput("\x1b");
		}) },
	};
	piPermissions(s.api());
	s.handlers.get("session_start")!.at(-1)!({}, ctx);
	await s.commands.get("permissions")!.handler("", ctx);
	const restored = new PermissionLedger(); restored.restore(s.entries.at(-1)!.data as PermissionRecord);
	expect(restored.open()).toEqual([]);
	expect(restored.isGranted("bash", input)).toBe(true);
	expect(restored.isGranted("bash", { command: "ssh host 'diagnose /tmp/b'" })).toBe(false);
	expect(restored.scenarioApprovals("bash", "/tmp")).toEqual([]);
	expect(restored.scenarioApprovals("bg_run", "/tmp")).toEqual([]);
	expect(s.sent[0]!.message.content).toContain("for the rest of this session, exactly as written");
	for (const toolCallId of ["retry1", "retry2"]) expect(await s.toolCall({ toolName: "bash", toolCallId, input }, ctx)).toBeUndefined();
	s.handlers.get("input")![0]!({ source: "interactive" }, ctx);
	expect(await s.toolCall({ toolName: "bash", toolCallId: "after-input", input }, ctx)).toBeUndefined();
	restored.revoke(restored.grantList()[0]!.key);
	expect(restored.isGranted("bash", input)).toBe(false);
});

it("menu approval persists child ownership and tells the parent to route the retry", async () => {
  const s = session();
  const ledger = new PermissionLedger();
  const owner = { sessionId: "worker-session", agentName: "integration-worker", cwd: "/tmp/child" };
  ledger.record({ toolCallId: "child-call", toolName: "bash", input: { command: "bun test" }, reason: "needs approval", owner });
  const branch = [{ type: "custom", customType: "pi-permissions", data: ledger.snapshot() }];
  const ctx = {
    cwd: "/tmp/parent", hasUI: false, isIdle: () => true,
    sessionManager: { getBranch: () => branch, getSessionId: () => "menu-parent" },
  };
  piPermissions(s.api());
  await s.handlers.get("session_start")!.at(-1)!({}, ctx);
  await s.commands.get("permissions")!.handler("approve last", ctx);
  expect(s.sent[0].message.content).toContain("session worker-session");
  expect(s.sent[0].message.content).toContain("do not execute this call in the parent");
  const restored = new PermissionLedger();
  restored.restore(s.entries.at(-1)?.data as PermissionRecord);
  expect(restored.scenarioApprovals("bash", owner.cwd, owner)).toHaveLength(1);
  expect(restored.scenarioApprovals("bash", owner.cwd)).toEqual([]);
  expect(restored.scenarioApprovals("bash", owner.cwd, { ...owner, sessionId: "sibling" })).toEqual([]);
});

it("menu directory approvals survive new user input and session restoration without an executable override", async () => {
  const s = session();
  const ledger = new PermissionLedger();
  const input = { path: "/tmp/directory-fixture/a.txt", content: "new" };
  ledger.record({ toolName: "write", toolCallId: "directory", input, reason: "Needs access", directories: [{ path: "/tmp/directory-fixture", access: "write" }] });
  s.entries.push({ type: "custom", customType: "pi-permissions", data: ledger.snapshot() });
  let rendered = "";
  const ctx = {
    cwd: "/tmp", mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => s.entries },
    ui: { notify() {}, custom: (factory: Function) => new Promise((resolve) => {
      const view = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_slot: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
      rendered = view.render(100).join("\n");
      view.handleInput("\r"); view.handleInput("\x1b");
    }) },
  };
  piPermissions(s.api());
  s.handlers.get("session_start")!.at(-1)!({}, ctx);
  await s.commands.get("permissions")!.handler("", ctx);
  expect(rendered).toContain("Read/write access under /tmp/directory-fixture");
  expect(rendered.replaceAll("│", "")).toMatch(/for this conversation, until\s+revoked/);
  s.handlers.get("input")![0]!({ source: "interactive" }, ctx);
  const restored = new PermissionLedger();
  restored.restore(s.entries.at(-1)!.data as PermissionRecord);
  expect(restored.directoryApprovals()).toHaveLength(1);
  expect(restored.isGranted("write", input)).toBe(false);
  expect(s.sent[0]!.message.content).toContain("Read/write access under /tmp/directory-fixture");
});


it("Ctrl+P opens the permissions menu without submitting a message", async () => {
 const s = session();
 piPermissions(s.api());
 let opened = 0;
 const ctx = { mode: "tui", cwd: "/tmp", hasUI: true, isIdle: () => true,
  sessionManager: { getBranch: () => [] },
  ui: { notify() {}, custom: async () => { opened++; return undefined; } },
 };
 await s.shortcuts.get("ctrl+p")!.handler(ctx);
 expect(opened).toBe(1);
 expect(s.sent).toEqual([]);
 expect(s.shortcuts.has("ctrl+shift+p")).toBe(false);
});

it("a linked native answer authorizes retry through the real gates but never a later hard denial", async () => {
	if (process.env.PI_APPROVAL_INTEGRATION_CHILD !== "1") {
		const home = mkdtempSync(join(tmpdir(), "pi-approval-integration-"));
		try {
			const directory = join(home, "extensions", "pi-permission-system");
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "config.json"), JSON.stringify({ authorizerChain: ["pi-automode"] }));
			const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "linked native answer"], { env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: home, PI_APPROVAL_INTEGRATION_CHILD: "1" }, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			expect({ code, output: code === 0 ? "passed" : stdout + stderr }).toEqual({ code: 0, output: "passed" });
		} finally { rmSync(home, { recursive: true, force: true }); }
		return;
	}
	const s = session();
	let hard = false;
	let classifications = 0;
	const api = s.api() as any;
	api.getAllTools = () => [{ name: "bash", description: "Shell" }, ...s.definitions.values()];
	api.getActiveTools = () => ["bash", ...s.tools];
	piPermissions(api, {
		loadConfig: () => ({ enabled: true, classifyReadOnlyTools: false, allowInsideWorkingDirectory: true, deniedPaths: [], protectedPaths: [], permissionDeny: [], permissionAsk: [], permissionAllow: [], environment: [], allow: [], softDeny: [], hardDeny: [], log: { enabled: false, classifierIo: false }, askOnBlock: { enabled: false, timeoutSeconds: 1 } }) as never,
		classifyAction: async () => { classifications++; return { decision: "block", tier: hard ? "hard_deny" : "soft_deny", reason: "Approval test" }; },
	});
	let questions = 0;
	const ctx = {
		cwd: "/tmp", hasUI: true, mode: "tui", isIdle: () => true, isProjectTrusted: () => true,
		ui: { notify() {}, setStatus() {}, theme: { fg: (_slot: string, text: string) => text }, custom: async (factory: any) => {
			questions++; let answer;
			const component = factory({ requestRender() {} }, { fg: (_slot: string, text: string) => text, bold: (text: string) => text }, {}, (value: unknown) => { answer = value; });
			component.handleInput("y"); component.dispose(); return answer;
		} },
		sessionManager: { getEntries: () => s.entries, getSessionId: () => "linked", getSessionName: () => "Linked approval test", getSessionFile: () => undefined, getSessionDir: () => "/tmp", getBranch: () => s.entries },
	};
	for (const start of s.handlers.get("session_start") ?? []) await start({}, ctx);
	const call = { toolName: "bash", toolCallId: "first", input: { command: "echo approval-test" } };
	const blocked = await s.toolCall(call, ctx);
	expect(blocked?.block).toBe(true);
	const record = s.entries.filter(e => e.customType === "pi-permissions").at(-1)!.data as PermissionRecord;
	const denial = record.denials[0]!;
	expect(denial.review).toEqual({ eligible: true, response: "unasked" });
	expect(blocked?.reason).toContain(`Denial reference: ${denial.id}`);
	expect(questions).toBe(0);
	expect(await s.toolCall({ toolName: "ask_for_approval", toolCallId: "review-gate", input: { denialId: denial.id } }, ctx)).toBeUndefined();
	expect(questions).toBe(0);
	const approval = await s.definitions.get("ask_for_approval").execute("review", { denialId: denial.id }, new AbortController().signal, undefined, ctx);
	expect(approval.details.status).toBe("approved");
	expect(questions).toBe(1);
	expect(await s.toolCall({ ...call, toolCallId: "retry" }, ctx)).toBeUndefined();
	expect(questions).toBe(1);
	expect(classifications).toBeGreaterThanOrEqual(2);
	hard = true;
	expect((await s.toolCall({ ...call, toolCallId: "hard" }, ctx))?.block).toBe(true);
	const latest = s.entries.filter(e => e.customType === "pi-permissions").at(-1)!.data as PermissionRecord;
	expect(latest.denials[0]!.review?.eligible).toBe(false);
	const refused = await s.definitions.get("ask_for_approval").execute("hard-review", { denialId: latest.denials[0]!.id }, new AbortController().signal, undefined, ctx);
	expect(refused.details.status).toBe("unavailable");
	expect(questions).toBe(1);
});

it("automatic folder approvals separate session, future, once and denial through the native gates", async () => {
	if (process.env.PI_DIRECTORY_INTEGRATION_CHILD !== "1") {
		const home = mkdtempSync(join(tmpdir(), "pi-directory-integration-"));
		try {
			const directory = join(home, "extensions", "pi-permission-system");
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "config.json"), JSON.stringify({ authorizerChain: ["pi-automode"], permission: { path_write: { [join(home, "target/restricted.ts")]: "deny", [join(home, "target/review.ts")]: "ask" } } }));
			const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "automatic folder approvals"], { env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: home, PI_DIRECTORY_INTEGRATION_CHILD: "1", PI_PERMISSION_DELEGATION_EXCLUDED_SURFACES: "external_directory,path" }, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			expect({ code, output: code === 0 ? "passed" : stdout + stderr }).toEqual({ code: 0, output: "passed" });
		} finally { rmSync(home, { recursive: true, force: true }); }
		return;
	}
	const { DirectoryGrantStore } = await import("./directory-store.ts");
	const launch = join(homedir(), "launch"); const target = join(homedir(), "target");
	mkdirSync(launch); mkdirSync(join(target, ".git"), { recursive: true });
	const store = new DirectoryGrantStore(join(homedir(), "saved-grants"));
	let serial = 0;
	async function start(cwd: string, initialKey: string, initialRead = false, modelOnly = false) {
		const s = session(); const id = `directory-${++serial}`;
		if (initialRead) {
			const ledger = new PermissionLedger(); ledger.approveDirectory({ path: target, access: "read" });
			s.entries.push({ type: "custom", customType: "pi-permissions", data: ledger.snapshot() });
		}
		let key: string | string[] = initialKey; let questions = 0; let proposals = 0; let hard = false;
		let beforeDecision: (() => void) | undefined;
		const rows: string[] = [];
		const notices: string[] = [];
		const api = s.api() as any;
		api.getAllTools = () => [{ name: "write", description: "Write" }, ...s.definitions.values()];
		api.getActiveTools = () => ["write", ...s.tools];
		piPermissions(api, {
			directoryStore: store,
			loadConfig: () => ({ enabled: true, classifyReadOnlyTools: false, allowInsideWorkingDirectory: false, deniedPaths: [], protectedPaths: [], permissionDeny: [], permissionAsk: [], permissionAllow: [], environment: [], allow: [], softDeny: [], hardDeny: [], log: { enabled: false, classifierIo: false }, askOnBlock: { enabled: true, timeoutSeconds: 1 } }) as never,
			classifyAction: async (_ctx, _config, _action, _context, approvals = []) => {
				beforeDecision?.();
				return hard ? { decision: "block", tier: "hard_deny", reason: "Hard policy test" }
					: modelOnly || approvals.some(grant => "kind" in grant && grant.path === target && grant.access === "write-execute")
						? { decision: "allow", tier: "allow", reason: "Verified folder scope" }
						: { decision: "block", tier: "soft_deny", reason: "Needs writable project access" };
			},
			proposeDirectories: async (_ctx, _config, _action, _context, candidates) => {
				proposals++; expect(candidates[0]?.path).toBe(target);
				return { directories: [{ candidate: 0, folder: 0, access: "write-execute" }] };
			},
		});
		const ctx = {
			cwd, hasUI: true, mode: "tui", isIdle: () => true, isProjectTrusted: () => true,
			ui: { notify(message: string) { notices.push(message); }, setStatus() {}, theme: { fg: (_slot: string, text: string) => text }, custom: async (factory: any) => {
				questions++; let answer;
				const component = factory({ requestRender() {}, terminal: { rows: 40 } }, { fg: (_slot: string, text: string) => text, bold: (text: string) => text }, { matches: () => false }, (value: unknown) => { answer = value; });
				rows.push(component.render(160).join("\n"));
				for (const data of Array.isArray(key) ? key : [key]) component.handleInput(data);
				component.dispose?.(); return answer;
			} },
			sessionManager: { getEntries: () => s.entries, getSessionId: () => id, getSessionName: () => id, getSessionFile: () => undefined, getSessionDir: () => cwd, getBranch: () => s.entries },
		};
		for (const handler of s.handlers.get("session_start") ?? []) await handler({}, ctx);
		const { getPermissionsService } = await import("./auto/permission-chain.ts");
		expect({ registered: getPermissionsService(globalThis, id) !== undefined, notices }).toEqual({ registered: true, notices: [] });
		return {
			call: (path = "research/new.ts") => s.toolCall({ toolName: "write", toolCallId: `write-${++serial}`, input: { path: join(target, path), content: "test" } }, ctx),
			key: (value: string | string[]) => { key = value; }, hard: () => { hard = true; },
			menu: () => s.commands.get("permissions")!.handler("", ctx),
			beforeDecision: (action: () => void) => { beforeDecision = action; },
			newInstruction: async () => { for (const handler of s.handlers.get("input") ?? []) await handler({ source: "user", text: "Proceed with the requested write" }, ctx); },
			questions: () => questions, proposals: () => proposals, rows,
			stop: async () => { for (const handler of s.handlers.get("session_shutdown") ?? []) await handler({}, ctx); },
		};
	}
	const unapproved = await start(launch, "n", false, true);
	expect((await unapproved.call())?.block).toBe(true);
	expect(unapproved.questions()).toBe(1);
	expect(unapproved.proposals()).toBe(0);
	await unapproved.stop();
	const first = await start(launch, "f", true);
	expect({ result: await first.call(), questions: first.questions(), proposals: first.proposals(), rows: first.rows })
		.toMatchObject({ result: undefined, questions: 1, proposals: 1 });
	expect(first.rows[0]).toContain(`sessions started in ${launch}`);
	expect(first.rows[0]).toContain("Read/write/execute");
	expect(store.load(launch)).toHaveLength(1);
	expect((await first.call("restricted.ts"))?.block).toBe(true);
	expect(first.questions()).toBe(1);
	first.key("n");
	expect((await first.call("review.ts"))?.block).toBe(true);
	expect(first.questions()).toBe(2);
	expect(first.rows.at(-1)).toContain("path_write");
	await first.stop();
	const revoked = await start(launch, "n", false, true);
	let decisions = 0;
	revoked.beforeDecision(() => {
		if (++decisions === 1) store.revoke(launch, { path: target, access: "write-execute" });
	});
	expect({ result: await revoked.call(), decisions, questions: revoked.questions(), proposals: revoked.proposals() })
		.toMatchObject({ result: { block: true }, decisions: 1, questions: 1, proposals: 0 });
	expect(revoked.questions()).toBe(1);
	expect(revoked.proposals()).toBe(0);
	await revoked.stop();
	store.save(launch, { path: target, access: "write-execute" });
	const resumed = await start(launch, "n");
	expect(await resumed.call()).toBeUndefined();
	expect(resumed.questions()).toBe(0);
	expect(resumed.proposals()).toBe(0);
	store.revoke(launch, { path: target, access: "write-execute" });
	resumed.key("Y");
	expect(await resumed.call()).toBeUndefined();
	expect(store.load(launch)).toEqual([]);
	resumed.key("n");
	expect((await resumed.call())?.block).toBe(true);
	expect(resumed.questions()).toBe(2);
	expect((await resumed.call())?.block).toBe(true);
	expect(resumed.questions()).toBe(2);
	await resumed.newInstruction();
	resumed.key("y");
	expect(await resumed.call()).toBeUndefined();
	expect(await resumed.call()).toBeUndefined();
	expect(resumed.questions()).toBe(3);
	expect(store.load(launch)).toEqual([]);
	resumed.hard(); resumed.key("Y");
	const proposals = resumed.proposals(); const questions = resumed.questions();
	expect((await resumed.call())?.block).toBe(true);
	expect(resumed.proposals()).toBe(proposals);
	expect(resumed.questions()).toBe(questions);
	await resumed.stop();
	store.save(launch, { path: target, access: "write-execute" });
	const elsewhere = await start(target, "n");
	expect((await elsewhere.call())?.block).toBe(true);
	expect(elsewhere.questions()).toBe(1);
	await elsewhere.stop();
	store.revoke(launch, { path: target, access: "write-execute" });
	const revoker = await start(launch, "n");
	store.save(launch, { path: target, access: "write-execute" });
	revoker.key(["\t", "x", "\x10"]);
	await revoker.menu();
	expect(store.load(launch)).toEqual([]);
	await revoker.stop();
});
