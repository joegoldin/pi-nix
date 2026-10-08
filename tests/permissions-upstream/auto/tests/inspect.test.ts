import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PROTECTED_PATHS,
	createPiAutomode,
	parseToolPattern,
	resolveLogPath,
} from "../extensions/auto-mode.ts";
import {
	baseConfig,
	baseState,
	createFakeCtx,
	createFakePi,
	setupHookTest,
} from "./test-helpers.ts";

test("automode_inspect bypasses classification without changing state or logs", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-inspect-"));
	try {
		const allow = parseToolPattern("bash(git status*)");
		assert.ok(allow);
		const sessionFile = join(dir, "session.jsonl");
		const ctx = createFakeCtx([], { sessionFile });
		const hook = await setupHookTest({
			config: baseConfig({
				permissionAllow: [allow],
				log: { enabled: true, classifierIo: true },
			}),
			ctx,
		});
		const result = await hook.emit(
			"tool_call",
			{ toolName: "automode_inspect", input: { action: "status" } },
			ctx,
		);
		assert.equal(result, undefined);
		assert.equal(hook.classifierCalls, 0);
		assert.equal(hook.entries.length, 0);
		assert.equal(existsSync(join(dir, "session-pi-automode.jsonl")), false);

		const output = await hook.tools.get("automode_inspect")?.execute(
			"call-1",
			{ action: "status" },
			undefined,
			undefined,
			ctx,
		);
		const parsed = JSON.parse(output.content[0].text);
		assert.match(parsed.status, /permissions\.allow rules: 1/);
		assert.equal(parsed.state.checkedActions, 0);
		assert.equal(parsed.state.blockedActions, 0);
		assert.equal(hook.entries.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("automode_inspect still obeys explicit permission denies", async () => {
	const pattern = parseToolPattern("automode_inspect");
	assert.ok(pattern);
	const hook = await setupHookTest({
		config: baseConfig({ permissionDeny: [pattern] }),
	});
	const result = await hook.emit(
		"tool_call",
		{ toolName: "automode_inspect", input: { action: "status" } },
		hook.ctx,
	) as { block?: boolean; reason?: string };
	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /Blocked by permissions\.deny: automode_inspect/);
	assert.equal(hook.classifierCalls, 0);
	assert.equal(hook.entries.at(-1)?.data.checkedActions, 1);
	assert.equal(hook.entries.at(-1)?.data.blockedActions, 1);
});

test("accepted permissions.ask routes automode_inspect to the classifier", async () => {
	const pattern = parseToolPattern("automode_inspect");
	assert.ok(pattern);
	const hook = await setupHookTest({
		config: baseConfig({ permissionAsk: [pattern] }),
		classifier: async () => ({ decision: "block", tier: "none", reason: "inspection requires review" }),
	});

	const result = await hook.emit(
		"tool_call",
		{ toolName: "automode_inspect", input: { action: "status" } },
		hook.ctx,
	) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /inspection requires review/);
	assert.equal(hook.classifierCalls, 1);
	assert.equal(hook.entries.at(-1)?.data.checkedActions, 1);
});

test("a colliding tool from another extension is not exempted", async () => {
	const fake = createFakePi();
	fake.pi.registerTool({
		name: "automode_inspect",
		sourceInfo: { path: "/tmp/other-extension.ts" },
		async execute() {
			return { content: [{ type: "text", text: "other" }] };
		},
	});
	let classifierCalls = 0;
	createPiAutomode({
		loadConfig: () => baseConfig(),
		classifyAction: async () => {
			classifierCalls += 1;
			return { decision: "allow", tier: "none", reason: "test allow" };
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	await fake.emit(
		"tool_call",
		{ toolName: "automode_inspect", input: { action: "status" } },
		ctx,
	);
	assert.equal(classifierCalls, 1);
	assert.equal(fake.entries.at(-1)?.data.checkedActions, 1);
});

test("automode_inspect reports the active in-memory config", async () => {
	const fake = createFakePi();
	let current = baseConfig({ classifierModel: "test/model-a" });
	createPiAutomode({ loadConfig: () => current })(fake.pi);
	const ctx = createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	current = baseConfig({ classifierModel: "test/model-b" });

	const output = await fake.tools.get("automode_inspect")?.execute(
		"call-2",
		{ action: "config" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(JSON.parse(output.content[0].text).config.classifierModel, "test/model-a");
});

test("automode_inspect reports the effective cwd's in-memory log path", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-inspect-log-"));
	try {
		const sessionCwd = join(dir, "effective-worktree");
		const logRoot = join(dir, "logs");
		const sessionId = "in-memory-session";
		const now = new Date("2026-08-21T12:00:00.000Z");
		const fake = createFakePi();
		createPiAutomode({
			loadConfig: () => baseConfig(),
			logRoot,
			now: () => now,
		})(fake.pi);
		const ctx = createFakeCtx(fake.entries, {
			cwd: sessionCwd,
			sessionDir: "",
			sessionId,
		});
		await fake.emit("session_start", { type: "session_start" }, ctx);

		const output = await fake.tools.get("automode_inspect")?.execute(
			"call-in-memory-log-path",
			{ action: "config" },
			undefined,
			undefined,
			ctx,
		);
		const expected = resolveLogPath(
			undefined, "", sessionId, sessionCwd, logRoot, now,
		);
		assert.equal(JSON.parse(output.content[0].text).logFile, expected);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("automode_inspect reports truncation metadata for arrays over 30 entries", async () => {
	assert.ok(DEFAULT_PROTECTED_PATHS.length > 30);
	const fake = createFakePi();
	createPiAutomode({ loadConfig: () => baseConfig() })(fake.pi);
	const ctx = createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);

	for (const action of ["defaults", "config"] as const) {
		const output = await fake.tools.get("automode_inspect")?.execute(
			`call-${action}`,
			{ action },
			undefined,
			undefined,
			ctx,
		);
		const parsed = JSON.parse(output.content[0].text);
		const protectedPaths = action === "defaults"
			? parsed.protectedPaths
			: parsed.config.protectedPaths;
		assert.deepEqual(protectedPaths, {
			$truncatedArray: true,
			items: DEFAULT_PROTECTED_PATHS.slice(0, 30),
			omittedEntries: DEFAULT_PROTECTED_PATHS.length - 30,
			totalEntries: DEFAULT_PROTECTED_PATHS.length,
		});
	}
});

test("automode_inspect omits denial reasons and action payloads", async () => {
	const fake = createFakePi();
	const persistedState = {
		type: "custom",
		customType: "pi-automode-state",
		data: baseState({
			checkedActions: 1,
			blockedActions: 1,
			classifierDenied: 1,
			lastDecision: "block",
			lastReason: "SECRET_REASON_MARKER",
			recentDenials: [{
				timestamp: 123,
				kind: "classifier",
				toolName: "bash",
				reason: "contains-sensitive-reason",
				action: "bash contains-sensitive-action",
			}],
		}),
	};
	createPiAutomode({ loadConfig: () => baseConfig() })(fake.pi);
	const ctx = createFakeCtx([persistedState]);
	await fake.emit("session_start", { type: "session_start" }, ctx);

	const denialOutput = await fake.tools.get("automode_inspect")?.execute(
		"call-3",
		{ action: "denials" },
		undefined,
		undefined,
		ctx,
	);
	assert.doesNotMatch(JSON.stringify(denialOutput), /contains-sensitive/);
	assert.deepEqual(JSON.parse(denialOutput.content[0].text).denials, [{
		timestamp: 123,
		kind: "classifier",
		toolName: "bash",
	}]);

	const statusOutput = await fake.tools.get("automode_inspect")?.execute(
		"call-4",
		{ action: "status" },
		undefined,
		undefined,
		ctx,
	);
	assert.doesNotMatch(JSON.stringify(statusOutput), /SECRET_REASON_MARKER/);
});
