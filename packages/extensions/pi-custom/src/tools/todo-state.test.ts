import { describe, expect, it } from "bun:test";
import { EMPTY, reduce, replay, sanitize, type TodoState, widgetLines } from "./todo-state.ts";

const plain = { fg: (_s: string, t: string) => t };

function run(...steps: Array<Parameters<typeof reduce>[1]>): { state: TodoState; texts: string[] } {
	let state = EMPTY;
	const texts: string[] = [];
	for (const step of steps) {
		const out = reduce(state, step);
		state = out.state;
		texts.push(out.text);
	}
	return { state, texts };
}

describe("create", () => {
	it("numbers tasks from 1 and reports them", () => {
		const { state, texts } = run({ action: "create", subject: "Write tests" }, { action: "create", subject: "Ship" });
		expect(texts).toEqual(["Created #1: Write tests (pending)", "Created #2: Ship (pending)"]);
		expect(state.nextId).toBe(3);
	});

	it("needs a subject", () => {
		expect(reduce(EMPTY, { action: "create", subject: "  " }).text).toBe("Error: subject required for create");
	});

	it("refuses dependencies that do not exist", () => {
		expect(reduce(EMPTY, { action: "create", subject: "x", blockedBy: [9] }).text).toBe("Error: blockedBy: #9 not found");
	});
});

describe("update", () => {
	it("reports a status change", () => {
		const { texts } = run({ action: "create", subject: "a" }, { action: "update", id: 1, status: "in_progress", activeForm: "doing a" });
		expect(texts[1]).toBe("Updated #1 (pending → in_progress)");
	});

	it("says when nothing changed", () => {
		const { texts } = run({ action: "create", subject: "a" }, { action: "update", id: 1, status: "pending" });
		expect(texts[1]).toBe("No change: #1 already matches the requested values (status: pending)");
	});

	it("rejects an update with nothing to change", () => {
		const { texts } = run({ action: "create", subject: "a" }, { action: "update", id: 1 });
		expect(texts[1]).toStartWith("Error: update requires at least one mutable field");
	});

	it("enforces the status machine", () => {
		const { texts } = run(
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "update", id: 1, status: "in_progress" },
		);
		expect(texts[2]).toBe("Error: illegal transition completed → in_progress");
	});

	it("merges dependencies and rejects cycles", () => {
		const { state, texts } = run(
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 2, addBlockedBy: [1] },
			{ action: "update", id: 1, addBlockedBy: [2] },
			{ action: "update", id: 1, addBlockedBy: [1] },
		);
		expect(state.tasks[1].blockedBy).toEqual([1]);
		expect(texts[3]).toBe("Error: addBlockedBy would create a cycle in the blockedBy graph");
		expect(texts[4]).toBe("Error: cannot block #1 on itself");
	});

	it("merges metadata and deletes keys set to null", () => {
		const { state } = run(
			{ action: "create", subject: "a", metadata: { x: 1, y: 2 } },
			{ action: "update", id: 1, metadata: { y: null, z: 3 } },
		);
		expect(state.tasks[0].metadata).toEqual({ x: 1, z: 3 });
	});
});

describe("reading", () => {
	const base = run(
		{ action: "create", subject: "a" },
		{ action: "create", subject: "b", blockedBy: [1] },
		{ action: "update", id: 1, status: "in_progress", activeForm: "doing a" },
		{ action: "create", subject: "c" },
		{ action: "delete", id: 3 },
	).state;

	it("lists live tasks with their active form and dependencies", () => {
		expect(reduce(base, { action: "list" }).text).toBe("[in_progress] #1 a (doing a)\n[pending] #2 b ⛓ #1");
	});

	it("shows tombstones only when asked", () => {
		expect(reduce(base, { action: "list", includeDeleted: true }).text).toContain("[deleted] #3 c");
	});

	it("gets one task with its edges both ways", () => {
		expect(reduce(base, { action: "get", id: 1 }).text).toBe("#1 [in_progress] a\n  activeForm: doing a\n  blocks: #2");
	});

	it("refuses to delete twice", () => {
		expect(reduce(base, { action: "delete", id: 3 }).text).toBe("Error: #3 is already deleted");
	});

	it("clears everything and counts what it cleared", () => {
		const out = reduce(base, { action: "clear" });
		expect(out.text).toBe("Cleared 3 tasks");
		expect(out.state).toEqual({ tasks: [], nextId: 1 });
	});
});

describe("replay", () => {
	it("takes the last todo result on the branch", () => {
		const entries = [
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 1, subject: "old", status: "pending" }], nextId: 2 } } },
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: {} } },
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [], nextId: 5 } } },
		];
		expect(replay(entries)).toEqual({ tasks: [], nextId: 5 });
		expect(replay([])).toEqual({ tasks: [], nextId: 1 });
	});
});

describe("the list above the editor", () => {
	it("is a heading and a tree", () => {
		const s = run({ action: "create", subject: "a" }, { action: "create", subject: "b" }).state;
		expect(widgetLines(s, new Set(), 12, plain)).toEqual(["● Todos (0/2)", "├─ ○ a", "└─ ○ b"]);
	});

	it("cuts completed tasks first when it runs out of room", () => {
		const s = run(
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "create", subject: "x" },
			{ action: "create", subject: "y" },
			{ action: "create", subject: "z" },
		).state;
		const lines = widgetLines(s, new Set(), 3, plain);
		expect(lines.at(-1)).toContain("more (");
		expect(lines.join("\n")).not.toContain("done");
	});

	it("wraps each task under its subject when given a width", () => {
		const s = run({ action: "create", subject: "one two three four" }, { action: "create", subject: "five six seven" }).state;
		expect(widgetLines(s, new Set(), 12, plain, false, 15)).toEqual([
			"● Todos (0/2)",
			"├─ ○ one two",
			"│    three four",
			"└─ ○ five six",
			"     seven",
		]);
	});

	it("disappears when everything left is hidden", () => {
		const s = run({ action: "create", subject: "a" }).state;
		expect(widgetLines(s, new Set([1]), 12, plain)).toEqual([]);
	});

	it("keeps terminal control characters out of what it draws", () => {
		expect(sanitize("a\x1b[31mred\x1b[0m\nb")).toBe("ared b");
	});
});
