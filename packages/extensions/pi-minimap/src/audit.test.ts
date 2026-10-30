import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAuditWriter, readCalls } from "./audit.ts";
import {
	CALL_TYPE,
	STATE_TYPE,
	emptySnapshot,
	restore,
	restoreUsage,
} from "./state.ts";

const dirs: string[] = [];
afterEach(() =>
	dirs
		.splice(0)
		.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
function session() {
	const dir = mkdtempSync(join(tmpdir(), "pi-minimap-audit-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	const source = manager.appendMessage({
		role: "user",
		content: "Build the minimap",
		timestamp: Date.now(),
	});
	return { manager, source };
}
test("disk resume retains full call text and every old displayed snapshot after folding", () => {
	const { manager, source } = session();
	const write = createAuditWriter(
		manager,
		() => manager,
		(type, data) => manager.appendCustomEntry(type, data),
	);
	write({
		id: "call-one",
		phase: "request",
		at: 1,
		model: "cerebras/qwen",
		prompt: "Full input\nline two",
		systemPrompt: "Observe only",
	});
	const text = "Full response " + "detail ".repeat(300);
	write({ id: "call-one", phase: "response", at: 2, text, stopReason: "stop" });
	const old = {
		...emptySnapshot(),
		now: "Original focus",
		focus: [{ topic: "Minimap", subtopics: ["Save history"] }],
		recent: [
			{
				text: "Original displayed message",
				from: source,
				to: source,
				tone: "success" as const,
			},
		],
	};
	manager.appendCustomEntry(STATE_TYPE, {
		...old,
		usageSessionId: manager.getSessionId(),
	});
	const firstState = manager.getLeafId();
	manager.appendCustomEntry(STATE_TYPE, {
		...old,
		now: "Next focus",
		recent: [],
		history: [{
			text: "Folded history", tone: "neutral", level: 1,
			from: source, to: source,
		}],
		usageSessionId: manager.getSessionId(),
	});
	const reopened = SessionManager.open(manager.getSessionFile()!);
	expect(
		readCalls(reopened.getEntries())[0].events.find(
			(e) => e.phase === "response",
		)?.text,
	).toBe(text);
	expect(reopened.getEntry(firstState!)?.type).toBe("custom");
	expect(JSON.stringify(reopened.getEntry(firstState!))).toContain(
		"Original displayed message",
	);
	expect(restore(reopened.getBranch()).history.map(item => item.text)).toEqual(["Folded history"]);
	expect(restore(reopened.getBranch()).focus).toEqual(old.focus);
});
test("late results stay with the originating session when the same manager forks", () => {
	const { manager, source } = session();
	const originalId = manager.getSessionId(),
		originalFile = manager.getSessionFile()!;
	const write = createAuditWriter(
		manager,
		() => manager,
		(type, data) => manager.appendCustomEntry(type, data),
	);
	write({ id: "late", phase: "request", at: 1, prompt: "Input" });
	const leaf = manager.getLeafId()!;
	manager.createBranchedSession(leaf);
	const forkId = manager.getSessionId();
	write({ id: "late", phase: "response", at: 2, text: "Result after fork" });
	const usage = {
		...emptySnapshot().usage,
		requests: 1,
		input: 20,
		output: 10,
		cost: 0.001,
	};
	write({ id: "late", phase: "accounting", at: 3, usage });
	const original = SessionManager.open(originalFile);
	expect(
		readCalls(original.getEntries())[0].events.some(
			(e) => e.phase === "response",
		),
	).toBe(true);
	expect(
		readCalls(manager.getEntries())[0].events.some(
			(e) => e.phase === "response",
		),
	).toBe(false);
	expect(restoreUsage(original.getEntries(), originalId)).toEqual(usage);
	expect(restoreUsage(manager.getEntries(), forkId).requests).toBe(0);
	expect(manager.getEntry(source)).toBeDefined();
});
test("audit redacts credentials but preserves long responses and terminal bytes safely in JSON", () => {
	const { manager } = session();
	const write = createAuditWriter(
		manager,
		() => manager,
		(type, data) => manager.appendCustomEntry(type, data),
	);
	write({
		id: "secret",
		phase: "response",
		at: 1,
		text: "Bearer do-not-save-this\n" + "x".repeat(10000),
	});
	const disk = readFileSync(manager.getSessionFile()!, "utf8");
	expect(disk).not.toContain("do-not-save-this");
	expect(readCalls(manager.getEntries())[0].events[0].text).toContain(
		"x".repeat(10000),
	);
	expect(
		manager
			.getEntries()
			.some((e) => e.type === "custom" && e.customType === CALL_TYPE),
	).toBe(true);
});

test("JSON-escaped credentials are redacted without discarding the rest of the response", () => {
	const { manager } = session();
	const write = createAuditWriter(
		manager,
		() => manager,
		(type, data) => manager.appendCustomEntry(type, data),
	);
	write({
		id: "escaped",
		phase: "response",
		at: 1,
		text: JSON.stringify({
			beat: 'api_key="do-not-store-me"; kept result',
			metadata: { password: "also-private" },
		}),
	});
	const saved = readCalls(manager.getEntries())[0].events[0].text!;
	expect(saved).not.toContain("do-not-store-me");
	expect(saved).not.toContain("also-private");
	expect(saved).toContain("kept result");
});

test("compaction remains append-only and unchanged disk resume makes no request", async () => {
	const { MinimapEngine } = await import("./engine.ts");
	const { readBatch } = await import("./state.ts");
	const { manager, source } = session();
	const state = { ...emptySnapshot(), lastId: source, now: "Saved focus" };
	manager.appendCustomEntry(STATE_TYPE, {
		...state,
		usageSessionId: manager.getSessionId(),
	});
	const file = manager.getSessionFile()!,
		before = readFileSync(file, "utf8");
	manager.appendCompaction("Compacted conversation", source, 100);
	expect(readFileSync(file, "utf8").startsWith(before)).toBe(true);
	const reopened = SessionManager.open(file);
	let requests = 0;
	const engine = new MinimapEngine(restore(reopened.getBranch()), {
		read: (last, recap) => readBatch(reopened.getBranch(), last, recap),
		request: async () => {
			requests++;
			return { text: "" };
		},
		changed() {},
		save() {},
	});
	try {
		engine.setVisible(true);
		await engine.refresh();
		expect(requests).toBe(0);
		expect(engine.state.now).toBe("Saved focus");
	} finally {
		engine.dispose();
	}
});
