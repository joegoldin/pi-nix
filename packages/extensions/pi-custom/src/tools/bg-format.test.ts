import { describe, expect, it } from "bun:test";
import {
	completionGuidance,
	formatDuration,
	formatLogs,
	formatNotification,
	formatSnapshotList,
	formatStarted,
	nameFromCommand,
	resolveId,
	sanitizeSegment,
	statusLine,
	type TaskSnapshot,
} from "./bg-format.ts";

const task = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
	id: "b1a2b3c4",
	name: "npm run test",
	command: "npm run test",
	status: "completed",
	pid: 4242,
	exitCode: 0,
	startTime: 0,
	endTime: 12_000,
	outputPath: ".pi/tasks/s-1/b1a2b3c4.output",
	...over,
});

describe("status list", () => {
	it("matches pi-background-tasks line for line", () => {
		expect(formatSnapshotList([task()])).toBe("✓ b1a2b3c4 completed 12s exit=0 pid=4242 — npm run test\n    output: .pi/tasks/s-1/b1a2b3c4.output");
	});

	it("says so when there is nothing", () => {
		expect(formatSnapshotList([])).toBe("No background tasks in this Pi extension runtime.");
	});

	it("shows an error, clipped", () => {
		const line = formatSnapshotList([task({ status: "failed", exitCode: 2, error: "x".repeat(200) })]);
		expect(line.startsWith("✗ b1a2b3c4 failed")).toBe(true);
		expect(line).toContain(" error=");
		expect(line.split("\n")[0].length).toBeLessThan(200);
	});

	it("ages a running task against now", () => {
		expect(formatSnapshotList([task({ status: "running", exitCode: undefined, endTime: undefined })], 61_000)).toContain("running 1m1s");
	});
});

describe("durations", () => {
	it("reads at every scale", () => {
		expect(formatDuration(500)).toBe("500ms");
		expect(formatDuration(5000)).toBe("5s");
		expect(formatDuration(125_000)).toBe("2m5s");
		expect(formatDuration(3_720_000)).toBe("1h2m");
	});
});

describe("bg_run's reply", () => {
	it("tells the model not to poll when it will be woken", () => {
		const text = formatStarted(task({ status: "running" }), true, true);
		expect(text.split("\n").slice(0, 4)).toEqual([
			"Started background task npm run test (b1a2b3c4)",
			"Status: running",
			"PID: 4242",
			"Output: .pi/tasks/s-1/b1a2b3c4.output",
		]);
		expect(text).toContain("do not poll or sleep merely to wait");
	});

	it("explains each opt-out", () => {
		expect(completionGuidance(true, false)).toContain("Automatic follow-up turn: disabled. The terminal notification will be delivered");
		expect(completionGuidance(false, true)).toContain("triggerOnCompletion has no effect while notifyOnCompletion is false");
		expect(completionGuidance(false, false)).toContain("Automatic follow-up turn: disabled.");
	});
});

describe("bg_logs", () => {
	it("points at the full file when it read it all", () => {
		expect(formatLogs("hi", 2, 2, true, "o")).toBe("hi\n\n[Full output: o]");
	});

	it("puts the notice first for a tail read and last for a head read", () => {
		expect(formatLogs("tail", 4096, 1024, true, "o").startsWith("[Showing tail 1.0KB of 4.0KB; 3.0KB omitted. Full output: o]")).toBe(true);
		expect(formatLogs("head", 4096, 1024, false, "o").endsWith("[Showing head 1.0KB of 4.0KB; 3.0KB omitted. Full output: o]")).toBe(true);
	});

	it("says when there is no output yet", () => {
		expect(formatLogs("", 0, 0, true, "o")).toBe("(no output yet)\n\n[Full output: o]");
	});
});

describe("the completion notification", () => {
	it("carries the terminal state as escaped XML", () => {
		const text = formatNotification(task({ status: "failed", exitCode: 1, error: "a < b" }));
		expect(text).toContain("<status>failed</status>");
		expect(text).toContain("<exit-code>1</exit-code>");
		expect(text).toContain("<error>a &lt; b</error>");
		expect(text.startsWith("<background-task-notification>")).toBe(true);
	});

	it("leaves out what it does not know", () => {
		expect(formatNotification(task({ exitCode: undefined }))).not.toContain("exit-code");
	});
});

describe("ids", () => {
	const tasks = [{ id: "babc1234" }, { id: "babd5678" }];

	it("resolves an exact id or a unique prefix", () => {
		expect(resolveId(tasks, "babc").id).toBe("babc1234");
		expect(resolveId(tasks, " babd5678 ").id).toBe("babd5678");
	});

	it("fails with pi-background-tasks' wording", () => {
		expect(() => resolveId(tasks, "bab")).toThrow('Ambiguous task ID prefix "bab": babc1234, babd5678');
		expect(() => resolveId(tasks, "x")).toThrow("Unknown background task ID: x");
		expect(() => resolveId(tasks, " ")).toThrow("Task ID is required");
	});
});

describe("small helpers", () => {
	it("names a task after its command when the model gave none", () => {
		expect(nameFromCommand("  npm   test ")).toBe("npm test");
	});

	it("makes a session id safe for a directory name", () => {
		expect(sanitizeSegment("a/b c:d")).toBe("a-b-c-d");
	});

	it("summarises the footer, and is silent when there is nothing to say", () => {
		const t = [task({ status: "running" }), task({ id: "b2", status: "failed" })];
		expect(statusLine(t, new Set())).toBe("bg 1 running · 1 failed");
		expect(statusLine([task()], new Set(["b1a2b3c4"]))).toBeUndefined();
	});
});
