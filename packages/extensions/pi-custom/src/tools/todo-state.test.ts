import { describe, expect, it } from "bun:test";
import { EMPTY, reduce, replay, sanitize, type TodoState, widgetRows, widgetLines, compactWidgetRows } from "./todo-state.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

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

describe("compact parent context", () => {
	const state: TodoState = { nextId: 8, tasks: [
		{ id: 1, subject: "Implement supervisor and notification input", kind: "group", status: "pending" },
		{ id: 2, subject: "Bind supervisor questions to durable human input", parentId: 1, status: "pending", blockedBy: [4, 5, 6] },
		{ id: 3, subject: "Finished child", parentId: 1, status: "completed" },
		{ id: 4, subject: "Controller", status: "pending" },
		{ id: 5, subject: "SSO", status: "pending" },
		{ id: 6, subject: "Review", status: "pending" },
		{ id: 7, subject: "Active child", parentId: 1, status: "in_progress", activeForm: "wiring the controller" },
	] };
	it("uses the full parent count even when siblings are hidden", () => {
		const rows = compactWidgetRows(state, new Set([3, 7]), plain, 160, "preview");
		expect(rows.map(row => row.text).join("\n")).toContain("#a Implement supervisor and notification input (1/3) -> #b Bind supervisor questions to durable human input ⛓ #d,#e,#f");
		expect(rows[0].text).toContain("1/6");
	});
	it("truncates both subjects before the parent count or dependency suffix", () => {
		const row = compactWidgetRows(state, new Set([3, 7]), plain, 85, "preview").find(row => row.text.includes("->"))!.text;
		expect(stripTerminalSequences(row)).toMatch(/#a Implement supervisor.*… \(1\/3\) -> #b Bind supervisor.*… ⛓ #d,#e,#f/);
		expect(visibleWidth(row)).toBeLessThanOrEqual(85);
	});
	it("retains parent context in focus mode, status and activity when space permits", () => {
		const rows = compactWidgetRows(state, new Set(), plain, 180, "minimal");
		expect(rows).toHaveLength(2);
		expect(rows[1].text).toContain("◐ #a Implement supervisor and notification input (1/3) -> #g Active child (wiring the controller)");
	});
	it("truncates ungrouped rows in preview and focus but keeps expanded text wrapped", () => {
		const subject = "Standalone acceptance task ".repeat(10);
		const standalone: TodoState = { nextId: 3, tasks: [
			{ id: 1, subject, status: "in_progress", blockedBy: [2] },
			{ id: 2, subject: "Dependency", status: "pending" },
		] };
		for (const view of ["minimal", "preview"] as const) {
			const rows = compactWidgetRows(standalone, new Set(), plain, 50, view);
			expect(stripTerminalSequences(rows[1].text)).toMatch(/◐ #a Standalone.*… ⛓ #b$/);
			for (const row of rows) expect(visibleWidth(row.text)).toBeLessThanOrEqual(50);
		}
		const expanded = widgetRows(standalone, new Set(), 12, plain, true, 50);
		expect(expanded.length).toBeGreaterThan(5);
		expect(expanded.map(row => stripTerminalSequences(row.text)).join("")).not.toContain("…");
	});
	it("bounds ANSI, wide and tiny rows without mutating task subjects", () => {
		const unicode = { ...state, tasks: state.tasks.map(task => ({ ...task, subject: task.subject + " 漢字👩‍💻".repeat(10) })) };
		const theme = { fg: (_slot: string, text: string) => `\x1b[36m${text}\x1b[39m` };
		for (const width of [1, 12, 40, 85, 120]) {
			for (const row of compactWidgetRows(unicode, new Set(), theme, width, "preview")) expect(visibleWidth(row.text)).toBeLessThanOrEqual(width);
		}
		expect(state.tasks[0].subject).toBe("Implement supervisor and notification input");
	});
});

describe("create", () => {
	it("reports alphabetical ids while preserving stored numeric keys", () => {
		const { state, texts } = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Write tests" }, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Ship" });
		expect(texts).toEqual(["Created #a: Write tests (pending)", "Created #b: Ship (pending)"]);
		expect(state.nextId).toBe(3);
	});

	it("needs a subject", () => {
		expect(reduce(EMPTY, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "  " }).text).toBe("Error: subject required for create");
	});

	it("refuses dependencies that do not exist", () => {
		expect(reduce(EMPTY, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "x", blockedBy: [9] }).text).toBe("Error: blockedBy: #i not found");
	});
});

describe("update", () => {
	it("reports a status change", () => {
		const { texts } = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "a" }, { action: "update", id: 1, status: "in_progress", activeForm: "doing a" });
		expect(texts[1]).toBe("Updated #a (pending → in_progress)");
	});

	it("says when nothing changed", () => {
		const { texts } = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "a" }, { action: "update", id: 1, status: "pending" });
		expect(texts[1]).toBe("No change: #a already matches the requested values (status: pending)");
	});

	it("rejects an update with nothing to change", () => {
		const { texts } = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "a" }, { action: "update", id: 1 });
		expect(texts[1]).toStartWith("Error: update requires at least one mutable field");
	});

	it("enforces the status machine", () => {
		const { texts } = run(
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "a" },
			{ action: "update", id: 1, evidence: "Verified the named outcome", status: "completed" },
			{ action: "update", id: 1, status: "in_progress" },
		);
		expect(texts[2]).toBe("Error: illegal transition completed → in_progress");
	});

	it("merges dependencies and rejects cycles", () => {
		const { state, texts } = run(
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "a" },
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "b" },
			{ action: "update", id: 2, addBlockedBy: [1] },
			{ action: "update", id: 1, addBlockedBy: [2] },
			{ action: "update", id: 1, addBlockedBy: [1] },
		);
		expect(state.tasks[1].blockedBy).toEqual([1]);
		expect(texts[3]).toBe("Error: addBlockedBy would create a cycle in the blockedBy graph");
		expect(texts[4]).toBe("Error: cannot block #a on itself");
	});

	it("merges metadata and deletes keys set to null", () => {
		const { state } = run(
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "a", metadata: { x: 1, y: 2 } },
			{ action: "update", id: 1, metadata: { y: null, z: 3 } },
		);
		expect(state.tasks[0].metadata).toEqual({ x: 1, z: 3 });
	});
});

describe("reading", () => {
	const base = run(
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "a" },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "b", blockedBy: [1] },
		{ action: "update", id: 1, status: "in_progress", activeForm: "doing a" },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "c" },
		{ action: "delete", id: 3 },
	).state;

	it("lists live tasks with their active form and dependencies", () => {
		expect(reduce(base, { action: "list" }).text).toBe("[in_progress] #a a (doing a)\n[pending] #b b ⛓ #a");
	});

	it("shows tombstones only when asked", () => {
		expect(reduce(base, { action: "list", includeDeleted: true }).text).toContain("[deleted] #c c");
	});

	it("gets one task with its edges both ways", () => {
		expect(reduce(base, { action: "get", id: 1 }).text).toBe("#a [in_progress] a\n  acceptanceCriteria: The named outcome is verified\n  activeForm: doing a\n  blocks: #b");
	});

	it("refuses to delete twice", () => {
		expect(reduce(base, { action: "delete", id: 3 }).text).toBe("Error: #c is already deleted");
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
		const s = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "a" }, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "b" }).state;
		expect(widgetLines(s, new Set(), 12, plain)).toEqual(["● Todos (0/2) · 0 complete · 0 active · 2 pending", "├─ ○ a", "└─ ○ b"]);
	});

	it("cuts completed tasks first when it runs out of room", () => {
		const s = run(
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "done" },
			{ action: "update", id: 1, evidence: "Verified the named outcome", status: "completed" },
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "x" },
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "y" },
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "z" },
		).state;
		const lines = widgetLines(s, new Set(), 3, plain);
		expect(lines.at(-1)).toContain("more unfinished");
		expect(lines.join("\n")).not.toContain("done");
	});

	it("wraps each task under its subject when given a width", () => {
		const s = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "one two three four" }, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "five six seven" }).state;
		expect(widgetLines(s, new Set(), 12, plain, false, 15)).toEqual([
			"● Todos (0/2)",
			"├─ ○ one two",
			"│    three four",
			"└─ ○ five six",
			"     seven",
		]);
	});

	it("disappears when everything left is hidden", () => {
		const s = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "a" }).state;
		expect(widgetLines(s, new Set([1]), 12, plain)).toEqual([]);
	});

	it("keeps terminal control characters out of what it draws", () => {
		expect(sanitize("a\x1b[31mred\x1b[0m\nb")).toBe("ared b");
	});
});

describe("one-level groups", () => {
	const grouped = () => run(
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Mac acceptance", kind: "group" },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Clipboard", parentId: 1 },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Notifications", parentId: 1 },
	).state;

	it("preserves parent links and derives progress without counting groups", () => {
		let state = grouped();
		expect(state.tasks[1].parentId).toBe(1);
		state = reduce(state, { action: "update", id: 2, evidence: "Verified the named outcome", status: "completed" }).state;
		expect(state.tasks[0].status).toBe("in_progress");
		expect(widgetLines(state, new Set(), 12, plain).join("\n")).toContain("Todos (1/2)");
		expect(reduce(state, { action: "get", id: 1 }).text).toContain("1/2");
		state = reduce(state, { action: "update", id: 3, evidence: "Verified the named outcome", status: "completed" }).state;
		expect(state.tasks[0].status).toBe("completed");
		state = reduce(state, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Launch", parentId: 1 }).state;
		expect(state.tasks[0].status).toBe("in_progress");
	});

	it("enforces one level on create and update", () => {
		const state = grouped();
		for (const params of [
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Nested", kind: "group", parentId: 1 },
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Grandchild", parentId: 2 },
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Missing", parentId: 99 },
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
		for (const action of [{ action: "update", id: 1, evidence: "Verified the named outcome", status: "completed" }, { action: "update", id: 1, status: "deleted" }, { action: "delete", id: 1 }] as const) {
			expect(reduce(state, action).error).toBeDefined();
		}
	});

	it("supports moving and detaching children, then deleting empty groups", () => {
		let state = grouped();
		state = reduce(state, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Release", kind: "group" }).state;
		state = reduce(state, { action: "update", id: 2, parentId: 4 }).state;
		state = reduce(state, { action: "update", id: 3, parentId: null }).state;
		expect(state.tasks[1].parentId).toBe(4);
		expect(state.tasks[2].parentId).toBeUndefined();
		expect(state.tasks[0].status).toBe("pending");
		state = reduce(state, { action: "delete", id: 1 }).state;
		expect(reduce(state, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Orphan", parentId: 1 }).error).toBeDefined();
	});

	it("keeps hierarchy separate from task dependencies", () => {
		const state = grouped();
		expect(reduce(state, { action: "update", id: 3, addBlockedBy: [2] }).error).toBeUndefined();
		expect(reduce(state, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Ship", blockedBy: [1] }).error).toBeDefined();
		expect(reduce(state, { action: "update", id: 2, addBlockedBy: [1] }).error).toBeDefined();
		expect(reduce(state, { action: "update", id: 1, addBlockedBy: [2] }).error).toBeDefined();
	});

	it("converts an umbrella task to a group without permitting a third level", () => {
		const { state } = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Whole project" }, { action: "update", id: 1, kind: "group" });
		expect(state.tasks[0].kind).toBe("group");
		expect(reduce(state, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Test", parentId: 1 }).error).toBeUndefined();
		const nested = reduce(state, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Test", parentId: 1 }).state;
		expect(reduce(nested, { action: "update", id: 1, kind: "task" }).error).toBeDefined();
	});

	it("lists groups and parent context even with a status filter", () => {
		const state = grouped();
		expect(reduce(state, { action: "list" }).text).toContain("[group pending] #a Mac acceptance (0/2)");
		expect(reduce(state, { action: "list", status: "pending" }).text).toContain("parent: #a");
		expect(reduce(state, { action: "get", id: 2 }).text).toContain("parent: #a");
	});

	it("replays both flat legacy lists and grouped state", () => {
		const recorded = { ...grouped(), tasks: grouped().tasks.map(t => ({ ...t, evidence: "Verified the named outcome", status: "completed" as const })) };
		const restored = replay([{ type: "message", message: { role: "toolResult", toolName: "todo", details: recorded } }]);
		expect(restored.tasks[1].parentId).toBe(1);
		expect(restored.tasks[0].status).toBe("completed");
		const flat = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Old task" }).state;
		expect(replay([{ type: "message", message: { role: "toolResult", toolName: "todo", details: flat } }])).toEqual(flat);
	});
});

describe("active task ownership", () => {
	it("returns previous work to pending when a new task starts", () => {
		const { state, texts } = run(
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "First" }, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Second" },
			{ action: "update", id: 1, status: "in_progress" }, { action: "update", id: 2, status: "in_progress" },
		);
		expect(state.tasks.map(t => t.status)).toEqual(["pending", "in_progress"]);
		expect(texts.at(-1)).toContain("#a");
	});

	it("allows parallel work only for distinct explicit owners", () => {
		let state = run(
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Linux", owner: "linux-worker" },
			{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Mac", owner: "mac-worker" },
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
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Mac acceptance", kind: "group" },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Clipboard", parentId: 1 },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Notifications", parentId: 1 },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Publish" },
	).state;
	it("renders a group header and indented children without an active-task glyph on the group", () => {
		const lines = widgetLines(state(), new Set(), 12, plain);
		expect(lines).toContain("├─ ▾ #a Mac acceptance (0/2)");
		expect(lines).toContain("│  ├─ ○ #b Clipboard");
		expect(lines).toContain("│  └─ ○ #c Notifications");
		expect(lines[0]).toBe("● Todos (0/3) · 0 complete · 0 active · 3 pending");
	});
	it("collapses individual groups without changing progress or standalone tasks", () => {
		const lines = widgetLines(state(), new Set(), 12, plain, false, undefined, new Set([1]));
		expect(lines.join("\n")).toContain("▸ #a Mac acceptance (0/2)");
		expect(lines.join("\n")).not.toContain("Clipboard");
		expect(lines.join("\n")).toContain("Publish");
		expect(lines[0]).toBe("● Todos (0/3) · 0 complete · 0 active · 3 pending");
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
	it("keeps derived group counts when completed children enter history", () => {
		const s = reduce(state(), { action: "update", id: 2, evidence: "Verified the named outcome", status: "completed" }).state;
		const lines = widgetLines(s, new Set([2]), 12, plain);
		expect(lines.join("\n")).toContain("Mac acceptance (1/2)");
		expect(lines.join("\n")).not.toContain("Clipboard");
	});
});

it("keeps a group heading even in the smallest row budget", () => {
	const { state } = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Group", kind: "group" }, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "One", parentId: 1 }, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Two", parentId: 1 });
	const lines = widgetLines(state, new Set(), 3, plain);
	expect(lines.length).toBe(3);
	expect(lines[1]).toContain("Group");
});

it("retains legacy tombstone metadata updates", () => {
	const { state } = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Old task" }, { action: "delete", id: 1 });
	const result = reduce(state, { action: "update", id: 1, description: "Superseded by another task" });
	expect(result.error).toBeUndefined();
	expect(result.state.tasks[0].status).toBe("deleted");
});

it("reports cleared tasks separately from groups", () => {
	const { state } = run({ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Group", kind: "group" }, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "One", parentId: 1 }, { action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Two", parentId: 1 });
	expect(reduce(state, { action: "clear" }).text).toBe("Cleared 2 tasks and 1 group");
});

describe("completed todo ordering", () => {
	const mixed = () => run(
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Finished root" },
		{ action: "update", id: 1, evidence: "Verified the named outcome", status: "completed" },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Group", kind: "group" },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Finished child", parentId: 2 },
		{ action: "update", id: 3, evidence: "Verified the named outcome", status: "completed" },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Open child", parentId: 2 },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", subject: "Open root" },
	).state;
	for (const expanded of [false, true]) it(`keeps completed roots and children in history only (${expanded ? "expanded" : "small compact"})`, () => {
		const state = mixed(); const before = JSON.stringify(state);
		const text = widgetLines(state, new Set(), 12, plain, expanded).join("\n");
		expect(text).toContain("Open child");
		expect(text).toContain("Open root");
		expect(text).not.toContain("Finished child");
		expect(text).not.toContain("Finished root");
		expect(JSON.stringify(state)).toBe(before);
	});
	it("does not let completed children consume slots before later unfinished roots", () => {
		const state = mixed();
		const lines = widgetLines(state, new Set(), 5, plain);
		expect(lines.join("\n")).toContain("Open root");
		expect(lines.join("\n")).not.toContain("Finished child");
		expect(lines.join("\n")).not.toContain("Finished root");
		expect(lines[0]).toContain("2/4");
		expect(lines).toHaveLength(4);
		expect(lines.length).toBeLessThanOrEqual(5);
	});
	it("keeps expansion work-only without losing group progress", () => {
		const text = widgetLines(mixed(), new Set([1, 3]), 12, plain, true).join("\n");
		expect(text).not.toContain("Finished root");
		expect(text).not.toContain("Finished child");
		expect(text).toContain("Group (1/2)");
	});
});


describe("completed group headers", () => {
	const completed = () => run(
		{ action: "create", acceptanceCriteria: "The named outcome is verified", kind: "group", subject: "Finished acceptance group" },
		{ action: "create", acceptanceCriteria: "The named outcome is verified", parentId: 1, subject: "Check" },
		{ action: "update", id: 2, evidence: "Verified the named outcome", status: "completed" },
	).state;
	const styled = { fg: (slot: string, text: string) => `<${slot}>${text}</${slot}>`, strikethrough: (text: string) => `<strike>${text}</strike>` };
	for (const collapsed of [false, true]) it(`archives completed groups regardless of ${collapsed ? "collapsed" : "expanded"} state`, () => {
		const state = completed();
		expect(widgetRows(state, new Set(), 12, styled, true, undefined, new Set(collapsed ? [1] : []))).toEqual([]);
		expect(reduce(state, { action: "history" }).text).toContain("Finished acceptance group (1/1)");
	});
	it("restores a group to the working list only when new work is added", () => {
		const state = completed();
		expect(widgetRows(state, new Set(), 12, plain, true, 24)).toEqual([]);
		const reopened = reduce(state, { action: "create", acceptanceCriteria: "The named outcome is verified", parentId: "a", subject: "Another check" }).state;
		const rows = widgetRows(reopened, new Set(), 12, styled, true);
		const header = rows.find(row => row.groupId === 1)!;
		expect(header.text).toContain("<accent>Finished acceptance group</accent>");
		expect(header.text).not.toContain("<strike>");
		expect(header.text).not.toContain("✓");
		expect(header.text).toContain("(1/2)");
		expect(rows.map(row => row.text).join("\n")).not.toContain("#b Check");
	});
});

describe("work-focused compact view", () => {
	it("keeps archived completions in overall counts but excludes them from overflow", () => {
		const state: TodoState = { nextId: 9, tasks: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, subject: `task ${i + 1}`, status: i < 3 ? "completed" : "pending" })) };
		const lines = widgetLines(state, new Set([1, 2, 3]), 4, plain);
		expect(lines[0]).toContain("Todos (3/8)");
		expect(lines[0]).toContain("3 complete");
		expect(lines.at(-1)).toContain("3 more unfinished");
		expect(lines.join("\n")).not.toContain("0 completed");
	});
	it("puts the active group's active child ahead of pending and blocked work", () => {
		const state: TodoState = { nextId: 6, tasks: [
			{ id: 1, subject: "blocked", status: "pending", blockedBy: [5] },
			{ id: 2, subject: "ready", status: "pending" },
			{ id: 3, subject: "group", kind: "group", status: "in_progress" },
			{ id: 4, subject: "waiting child", parentId: 3, status: "pending" },
			{ id: 5, subject: "active child", parentId: 3, status: "in_progress" },
		] };
		const lines = widgetLines(state, new Set(), 4, plain);
		expect(lines[1]).toContain("group");
		expect(lines[2]).toContain("active child");
	});
	it("hides satisfied dependency edges without deleting their history", () => {
		const state: TodoState = { nextId: 3, tasks: [
			{ id: 1, subject: "done", evidence: "Verified the named outcome", status: "completed" },
			{ id: 2, subject: "ready", status: "pending", blockedBy: [1] },
		] };
		expect(widgetLines(state, new Set([1]), 12, plain).join("\n")).not.toContain("⛓");
		expect(state.tasks[1].blockedBy).toEqual([1]);
	});
});


describe("task contracts", () => {
	it("requires an explicit completion check on new tasks, but not groups", () => {
		expect(reduce(EMPTY, { action: "create", subject: "Fix it" }).error).toContain("acceptanceCriteria");
		expect(reduce(EMPTY, { action: "create", subject: "Release", kind: "group" }).error).toBeUndefined();
	});
	it("keeps acceptance criteria stable while allowing progress notes", () => {
		const state = reduce(EMPTY, { action: "create", subject: "Fix count", acceptanceCriteria: "Renderer regression passes" }).state;
		expect(reduce(state, { action: "update", id: 1, acceptanceCriteria: "Ship everything" }).error).toContain("stable");
		expect(reduce(state, { action: "update", id: 1, description: "Regression reproduced" }).error).toBeUndefined();
	});
	it("requires completion evidence and retains it in get and replay", () => {
		const state = reduce(EMPTY, { action: "create", subject: "Fix count", acceptanceCriteria: "Renderer regression passes" }).state;
		expect(reduce(state, { action: "update", id: 1, status: "completed" }).error).toContain("evidence");
		const done = reduce(state, { action: "update", id: 1, status: "completed", evidence: "bun test: 48 pass" }).state;
		const restored = replay([{ type: "custom", customType: "pi-custom:todo-state", data: done }]);
		expect(reduce(restored, { action: "get", id: 1 }).text).toContain("bun test: 48 pass");
		expect(reduce(restored, { action: "get", id: 1 }).text).toContain("Renderer regression passes");
	});
	it("lets legacy tasks acquire criteria without rewriting their history", () => {
		const state: TodoState = { tasks: [{ id: 1, subject: "Legacy", status: "pending" }], nextId: 2 };
		expect(replay([{ type: "custom", customType: "pi-custom:todo-state", data: state }])).toEqual(state);
		expect(reduce(state, { action: "update", id: 1, acceptanceCriteria: "Legacy check passes" }).state.tasks[0].acceptanceCriteria).toBe("Legacy check passes");
	});
});

describe("completed history leaves the working list", () => {
	const state = run(
		{ action: "create", subject: "Finished", acceptanceCriteria: "Tests pass" },
		{ action: "update", id: 1, status: "completed", evidence: "Tests passed" },
		{ action: "create", subject: "Next", acceptanceCriteria: "Acceptance passes", blockedBy: [1] },
	).state;

	it("lists unfinished tasks by default without deleting evidence or dependencies", () => {
		expect(reduce(state, { action: "list" }).text).toBe("[pending] #b Next ⛓ #a");
		expect(reduce(state, { action: "list", status: "completed" }).text).toBe("[completed] #a Finished");
		expect(reduce(state, { action: "get", id: 1 }).text).toContain("evidence: Tests passed");
		expect(reduce(state, { action: "list" }).state).toBe(state);
	});

	it("returns no tasks for a completed-only working list", () => {
		expect(reduce({ ...state, tasks: state.tasks.slice(0, 1) }, { action: "list" }).text).toBe("No tasks");
	});

	it("keeps compact and expanded counts identical while history stays separate", () => {
		const compact = widgetLines(state, new Set([1]), 12, plain).join("\n");
		expect(compact).toContain("Todos (1/2)");
		expect(compact).not.toContain("Finished");
		expect(compact).not.toContain("⛓");
		const expanded = widgetLines(state, new Set([1]), 12, plain, true).join("\n");
		expect(expanded).toContain("Todos (1/2)");
		expect(expanded).not.toContain("Finished");
		expect(reduce(state, { action: "history" }).text).toContain("Finished");
	});

	it("hides completed groups and children from default lists", () => {
		const grouped = run(
			{ action: "create", subject: "Batch", kind: "group" },
			{ action: "create", subject: "Child", parentId: 1, acceptanceCriteria: "Tests pass" },
			{ action: "update", id: 2, status: "completed", evidence: "Tests passed" },
		).state;
		expect(reduce(grouped, { action: "list" }).text).toBe("No tasks");
		expect(reduce(grouped, { action: "list", status: "completed" }).text).toContain("[group completed]");
	});
});

// Expanded working views must not turn the conversation's task history back
// into a backlog, even when the user expands every tool globally.
describe("separate working list and conversation history", () => {
	const state: TodoState = { nextId: 45, tasks: [
		{ id: 1, subject: "Batch", kind: "group", status: "in_progress" },
		...Array.from({ length: 40 }, (_, i) => ({ id: i + 2, subject: `Finished check ${i}`, parentId: 1, status: "completed" as const, evidence: `Check ${i} passed` })),
		{ id: 42, subject: "Remaining check", parentId: 1, status: "pending", blockedBy: [41] },
		{ id: 43, subject: "Archived experiment", status: "deleted", description: "Superseded" },
		{ id: 44, subject: "Finished standalone", status: "completed", evidence: "Verified standalone" },
	] };
	it("never reintroduces completed rows in expanded working views", () => {
		for (const expanded of [false, true]) {
			const text = widgetLines(state, new Set(), 12, plain, expanded).join("\n");
			expect(text).not.toContain("Finished check");
			expect(text).not.toContain("Finished standalone");
			expect(text).not.toContain("Archived experiment");
			expect(text).toContain("Remaining check");
			expect(text).toContain("Batch (40/41)");
			expect(text).toContain("41/42");
		}
	});
	it("keeps completions, tombstones and their evidence in an explicit history list", () => {
		const history = reduce(state, { action: "history" });
		expect(history.text).toContain("Finished check 39");
		expect(history.text).toContain("Archived experiment");
		expect(history.text).not.toContain("Remaining check");
		expect(history.state).toBe(state);
		const restored = replay([{ type: "custom", customType: "pi-custom:todo-state", data: state }]);
		expect(reduce(restored, { action: "get", id: 41 }).text).toContain("Check 39 passed");
		expect(restored.tasks.find(task => task.id === 42)?.blockedBy).toEqual([41]);
	});
});

describe("alphabetical public task ids", () => {
	it("uses spreadsheet-style letters, including rollover, without renumbering history", () => {
		for (const [id, label] of [[1, "a"], [26, "z"], [27, "aa"], [28, "ab"], [52, "az"], [53, "ba"], [702, "zz"], [703, "aaa"]] as const) {
			const result = reduce({ tasks: [], nextId: id }, { action: "create", subject: "Check", acceptanceCriteria: "Verified" });
			expect(result.text).toBe(`Created #${label}: Check (pending)`);
		}
	});
	it("resolves alphabetical dependencies and parent links against numeric legacy state", () => {
		let state: TodoState = { nextId: 29, tasks: [
			{ id: 1, subject: "Batch", kind: "group", status: "pending" },
			{ id: 26, subject: "Dependency", status: "pending" },
			{ id: 27, subject: "Follow-up", status: "pending" },
		] };
		const linked = reduce(state, { action: "update", id: "aa", parentId: "a", addBlockedBy: ["z"] });
		expect(linked.error).toBeUndefined(); state = linked.state;
		expect(state.tasks[2].parentId).toBe(1);
		expect(state.tasks[2].blockedBy).toEqual([26]);
		expect(reduce(state, { action: "get", id: "aa" } as never).text).toContain("blockedBy: #z");
		expect(reduce(state, { action: "update", id: "z", addBlockedBy: ["aa"] } as never).error).toContain("cycle");
		expect(reduce(state, { action: "update", id: "aa", removeBlockedBy: ["z"], parentId: null } as never).state.tasks[2].blockedBy).toBeUndefined();
	});
});

it("rejects malformed and overflowing references without mutating legacy state", () => {
	const state = reduce(EMPTY, { action: "create", subject: "Work", acceptanceCriteria: "Verified" }).state;
	for (const id of ["", "1", "a-b", "a\n", "a".repeat(100), 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		for (const params of [{ action: "get", id }, { action: "update", id: "a", addBlockedBy: [id] }, { action: "create", subject: "Child", acceptanceCriteria: "Verified", parentId: id }] as const) {
			const out = reduce(state, params as never);
			expect(out.error).toContain("alphabetical");
			expect(out.state).toBe(state);
		}
	}
	expect(reduce(state, { action: "get", id: "A" }).text).toContain("#a");
});
