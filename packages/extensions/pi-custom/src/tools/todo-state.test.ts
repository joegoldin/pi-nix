import { describe, expect, it } from "bun:test";
import { EMPTY, reduce, replay, sanitize, type TodoState, widgetRows, widgetLines } from "./todo-state.ts";

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

describe("one-level groups", () => {
	const grouped = () => run(
		{ action: "create", subject: "Mac acceptance", kind: "group" },
		{ action: "create", subject: "Clipboard", parentId: 1 },
		{ action: "create", subject: "Notifications", parentId: 1 },
	).state;

	it("preserves parent links and derives progress without counting groups", () => {
		let state = grouped();
		expect(state.tasks[1].parentId).toBe(1);
		state = reduce(state, { action: "update", id: 2, status: "completed" }).state;
		expect(state.tasks[0].status).toBe("in_progress");
		expect(widgetLines(state, new Set(), 12, plain).join("\n")).toContain("Todos (1/2)");
		expect(reduce(state, { action: "get", id: 1 }).text).toContain("1/2");
		state = reduce(state, { action: "update", id: 3, status: "completed" }).state;
		expect(state.tasks[0].status).toBe("completed");
		state = reduce(state, { action: "create", subject: "Launch", parentId: 1 }).state;
		expect(state.tasks[0].status).toBe("in_progress");
	});

	it("enforces one level on create and update", () => {
		const state = grouped();
		for (const params of [
			{ action: "create", subject: "Nested", kind: "group", parentId: 1 },
			{ action: "create", subject: "Grandchild", parentId: 2 },
			{ action: "create", subject: "Missing", parentId: 99 },
			{ action: "update", id: 1, parentId: 1 },
			{ action: "update", id: 2, kind: "group" },
			{ action: "update", id: 3, parentId: 2 },
		] as const) {
			const out = reduce(state, params);
			expect(out.error).toBeDefined();
			expect(out.state).toBe(state);
		}
	});

	it("does not accept manual group completion or delete populated groups", () => {
		const state = grouped();
		for (const action of [{ action: "update", id: 1, status: "completed" }, { action: "update", id: 1, status: "deleted" }, { action: "delete", id: 1 }] as const) {
			expect(reduce(state, action).error).toBeDefined();
		}
	});

	it("supports moving and detaching children, then deleting empty groups", () => {
		let state = grouped();
		state = reduce(state, { action: "create", subject: "Release", kind: "group" }).state;
		state = reduce(state, { action: "update", id: 2, parentId: 4 }).state;
		state = reduce(state, { action: "update", id: 3, parentId: null }).state;
		expect(state.tasks[1].parentId).toBe(4);
		expect(state.tasks[2].parentId).toBeUndefined();
		expect(state.tasks[0].status).toBe("pending");
		state = reduce(state, { action: "delete", id: 1 }).state;
		expect(reduce(state, { action: "create", subject: "Orphan", parentId: 1 }).error).toBeDefined();
	});

	it("keeps hierarchy separate from task dependencies", () => {
		const state = grouped();
		expect(reduce(state, { action: "update", id: 3, addBlockedBy: [2] }).error).toBeUndefined();
		expect(reduce(state, { action: "create", subject: "Ship", blockedBy: [1] }).error).toBeDefined();
		expect(reduce(state, { action: "update", id: 2, addBlockedBy: [1] }).error).toBeDefined();
		expect(reduce(state, { action: "update", id: 1, addBlockedBy: [2] }).error).toBeDefined();
	});

	it("converts an umbrella task to a group without permitting a third level", () => {
		const { state } = run({ action: "create", subject: "Whole project" }, { action: "update", id: 1, kind: "group" });
		expect(state.tasks[0].kind).toBe("group");
		expect(reduce(state, { action: "create", subject: "Test", parentId: 1 }).error).toBeUndefined();
		const nested = reduce(state, { action: "create", subject: "Test", parentId: 1 }).state;
		expect(reduce(nested, { action: "update", id: 1, kind: "task" }).error).toBeDefined();
	});

	it("lists groups and parent context even with a status filter", () => {
		const state = grouped();
		expect(reduce(state, { action: "list" }).text).toContain("[group pending] #1 Mac acceptance (0/2)");
		expect(reduce(state, { action: "list", status: "pending" }).text).toContain("parent: #1");
		expect(reduce(state, { action: "get", id: 2 }).text).toContain("parent: #1");
	});

	it("replays both flat legacy lists and grouped state", () => {
		const recorded = { ...grouped(), tasks: grouped().tasks.map(t => ({ ...t, status: "completed" as const })) };
		const restored = replay([{ type: "message", message: { role: "toolResult", toolName: "todo", details: recorded } }]);
		expect(restored.tasks[1].parentId).toBe(1);
		expect(restored.tasks[0].status).toBe("completed");
		const flat = run({ action: "create", subject: "Old task" }).state;
		expect(replay([{ type: "message", message: { role: "toolResult", toolName: "todo", details: flat } }])).toEqual(flat);
	});
});

describe("active task ownership", () => {
	it("returns previous work to pending when a new task starts", () => {
		const { state, texts } = run(
			{ action: "create", subject: "First" }, { action: "create", subject: "Second" },
			{ action: "update", id: 1, status: "in_progress" }, { action: "update", id: 2, status: "in_progress" },
		);
		expect(state.tasks.map(t => t.status)).toEqual(["pending", "in_progress"]);
		expect(texts.at(-1)).toContain("#1");
	});

	it("allows parallel work only for distinct explicit owners", () => {
		let state = run(
			{ action: "create", subject: "Linux", owner: "linux-worker" },
			{ action: "create", subject: "Mac", owner: "mac-worker" },
			{ action: "update", id: 1, status: "in_progress" },
			{ action: "update", id: 2, status: "in_progress" },
		).state;
		expect(state.tasks.map(t => t.status)).toEqual(["in_progress", "in_progress"]);
		state = reduce(state, { action: "update", id: 2, owner: "linux-worker" }).state;
		expect(state.tasks.map(t => t.status)).toEqual(["pending", "in_progress"]);
	});
});

describe("grouped widget", () => {
	const state = () => run(
		{ action: "create", subject: "Mac acceptance", kind: "group" },
		{ action: "create", subject: "Clipboard", parentId: 1 },
		{ action: "create", subject: "Notifications", parentId: 1 },
		{ action: "create", subject: "Publish" },
	).state;
	it("renders a group header and indented children without an active-task glyph on the group", () => {
		const lines = widgetLines(state(), new Set(), 12, plain);
		expect(lines).toContain("├─ ▾ #1 Mac acceptance (0/2)");
		expect(lines).toContain("│  ├─ ○ #2 Clipboard");
		expect(lines).toContain("│  └─ ○ #3 Notifications");
		expect(lines[0]).toBe("● Todos (0/3)");
	});
	it("collapses individual groups without changing progress or standalone tasks", () => {
		const lines = widgetLines(state(), new Set(), 12, plain, false, undefined, new Set([1]));
		expect(lines.join("\n")).toContain("▸ #1 Mac acceptance (0/2)");
		expect(lines.join("\n")).not.toContain("Clipboard");
		expect(lines.join("\n")).toContain("Publish");
		expect(lines[0]).toBe("● Todos (0/3)");
	});
	it("keeps parent context when truncating and never exceeds the unwrapped row budget", () => {
		const lines = widgetLines(state(), new Set(), 4, plain);
		expect(lines.length).toBeLessThanOrEqual(4);
		expect(lines.join("\n")).toContain("Mac acceptance");
		expect(lines.join("\n")).toContain("Clipboard");
		expect(lines.at(-1)).toContain("more");
	});
	it("does not hide a reopened group behind its previous completed state", () => {
		const lines = widgetLines(state(), new Set([1]), 12, plain);
		expect(lines.join("\n")).toContain("Mac acceptance");
		expect(lines.join("\n")).toContain("Clipboard");
	});
	it("keeps derived group counts when completed children fade", () => {
		const s = reduce(state(), { action: "update", id: 2, status: "completed" }).state;
		const lines = widgetLines(s, new Set([2]), 12, plain);
		expect(lines.join("\n")).toContain("Mac acceptance (1/2)");
		expect(lines.join("\n")).not.toContain("Clipboard");
	});
});

it("keeps a group heading even in the smallest row budget", () => {
	const { state } = run({ action: "create", subject: "Group", kind: "group" }, { action: "create", subject: "One", parentId: 1 }, { action: "create", subject: "Two", parentId: 1 });
	const lines = widgetLines(state, new Set(), 3, plain);
	expect(lines.length).toBe(3);
	expect(lines[1]).toContain("Group");
});

it("retains legacy tombstone metadata updates", () => {
	const { state } = run({ action: "create", subject: "Old task" }, { action: "delete", id: 1 });
	const result = reduce(state, { action: "update", id: 1, description: "Superseded by another task" });
	expect(result.error).toBeUndefined();
	expect(result.state.tasks[0].status).toBe("deleted");
});

it("reports cleared tasks separately from groups", () => {
	const { state } = run({ action: "create", subject: "Group", kind: "group" }, { action: "create", subject: "One", parentId: 1 }, { action: "create", subject: "Two", parentId: 1 });
	expect(reduce(state, { action: "clear" }).text).toBe("Cleared 2 tasks and 1 group");
});

describe("completed todo ordering", () => {
	const mixed = () => run(
		{ action: "create", subject: "Finished root" },
		{ action: "update", id: 1, status: "completed" },
		{ action: "create", subject: "Group", kind: "group" },
		{ action: "create", subject: "Finished child", parentId: 2 },
		{ action: "update", id: 3, status: "completed" },
		{ action: "create", subject: "Open child", parentId: 2 },
		{ action: "create", subject: "Open root" },
	).state;
	for (const expanded of [false, true]) it(`puts completed roots and children last (${expanded ? "expanded" : "small compact"})`, () => {
		const state = mixed(); const before = JSON.stringify(state);
		const text = widgetLines(state, new Set(), 12, plain, expanded).join("\n");
		expect(text.indexOf("Open child")).toBeLessThan(text.indexOf("Finished child"));
		expect(text.indexOf("Open root")).toBeLessThan(text.indexOf("Finished root"));
		expect(JSON.stringify(state)).toBe(before);
	});
	it("does not let completed children consume slots before later unfinished roots", () => {
		const state = mixed();
		const lines = widgetLines(state, new Set(), 5, plain);
		expect(lines.join("\n")).toContain("Open root");
		expect(lines.join("\n")).not.toContain("Finished child");
		expect(lines.join("\n")).not.toContain("Finished root");
		expect(lines[0]).toContain("2/4");
		expect(lines.at(-1)).toContain("2 completed");
		expect(lines.length).toBeLessThanOrEqual(5);
	});
	it("lets expansion reveal faded completions without losing group progress", () => {
		const text = widgetLines(mixed(), new Set([1, 3]), 12, plain, true).join("\n");
		expect(text).toContain("Finished root");
		expect(text).toContain("Finished child");
		expect(text).toContain("Group (1/2)");
	});
});


describe("completed group headers", () => {
	const completed = () => run(
		{ action: "create", kind: "group", subject: "Finished acceptance group" },
		{ action: "create", parentId: 1, subject: "Check" },
		{ action: "update", id: 2, status: "completed" },
	).state;
	const styled = { fg: (slot: string, text: string) => `<${slot}>${text}</${slot}>`, strikethrough: (text: string) => `<strike>${text}</strike>` };
	for (const collapsed of [false, true]) it(`marks the completed group without losing its ${collapsed ? "collapsed" : "expanded"} arrow`, () => {
		const rows = widgetRows(completed(), new Set(), 12, styled, true, undefined, new Set(collapsed ? [1] : []));
		const header = rows.find(row => row.groupId === 1)!;
		expect(header.text).toContain(collapsed ? "▸" : "▾");
		expect(header.text).toContain("<success>✓ </success>");
		expect(header.text).toContain("<muted><strike>Finished acceptance group</strike></muted>");
		expect(header.text).toContain("(1/1)");
	});
	it("keeps wrapped completed headers clickable and restores open styling when a child is added", () => {
		const state = completed();
		const rows = widgetRows(state, new Set(), 12, plain, true, 24);
		expect(rows.filter(row => row.groupId === 1).length).toBeGreaterThan(1);
		expect(rows.every(row => row.text.length <= 24)).toBe(true);
		const reopened = reduce(state, { action: "create", parentId: 1, subject: "Another check" }).state;
		const header = widgetRows(reopened, new Set(), 12, styled, true).find(row => row.groupId === 1)!;
		expect(header.text).toContain("<accent>Finished acceptance group</accent>");
		expect(header.text).not.toContain("<strike>");
		expect(header.text).not.toContain("✓");
		expect(header.text).toContain("(1/2)");
	});
});
