import { describe, expect, it } from "bun:test";
import type { UiTheme } from "./card.ts";
import { type EntryLike, formatDuration, GroupState, LiveFeed, type MessageLike, planRow, RunModel, runSummary, type ToolRun } from "./group.ts";

const plain: UiTheme = { fg: (_s, t) => t, bold: (t) => t, italic: (t) => t };

const call = (id: string, name = "bash") => ({ type: "toolCall", id, name, arguments: {} });
const text = (t: string) => ({ type: "text", text: t });
const thinking = (t = "hm") => ({ type: "thinking", thinking: t });
const assistant = (...content: object[]): MessageLike => ({ role: "assistant", content, stopReason: "toolUse" });
const result = (id: string, isError = false): MessageLike => ({ role: "toolResult", toolCallId: id, isError });
const entry = (message: MessageLike): EntryLike => ({ type: "message", message });

function loaded(...messages: MessageLike[]): RunModel {
	const model = new RunModel();
	model.load(messages.map(entry));
	return model;
}

const ids = (run: ToolRun | undefined) => run?.calls.map((c) => c.id);

describe("runs from a session branch", () => {
	it("groups consecutive exploratory calls across assistant messages", () => {
		const model = loaded(assistant(call("a")), result("a"), assistant(call("b", "read"), call("c", "grep")), result("b"), result("c"));
		expect(ids(model.runOf("c"))).toEqual(["a", "b", "c"]);
		expect(model.runOf("a")).toBe(model.runOf("c"));
	});

	it("breaks a run on prose, but not on empty text or thinking", () => {
		const model = loaded(
			assistant(call("a")),
			assistant(text("  "), thinking(), call("b")),
			assistant(text("Found it."), call("c")),
		);
		expect(ids(model.runOf("a"))).toEqual(["a", "b"]);
		expect(ids(model.runOf("c"))).toEqual(["c"]);
	});

	it("breaks a run on a call that does not group, and leaves that call out", () => {
		const model = loaded(assistant(call("a"), call("e", "edit"), call("b", "ls")), assistant(call("s", "subagent")), assistant(call("c")));
		expect(model.runOf("e")).toBeUndefined();
		expect(model.runOf("s")).toBeUndefined();
		expect(ids(model.runOf("a"))).toEqual(["a"]);
		expect(ids(model.runOf("b"))).toEqual(["b"]);
		expect(ids(model.runOf("c"))).toEqual(["c"]);
	});

	it("breaks a run on a user message, a shown custom message and a compaction, not a hidden custom one", () => {
		const model = new RunModel();
		model.load([
			entry(assistant(call("a"))),
			entry({ role: "custom", display: false }),
			entry(assistant(call("b"))),
			entry({ role: "user", content: "go on" }),
			entry(assistant(call("c"))),
			{ type: "custom_message", display: true },
			entry(assistant(call("d"))),
			{ type: "compaction" },
			entry(assistant(call("e"))),
			{ type: "model_change" },
			entry(assistant(call("f"))),
		]);
		expect(ids(model.runOf("a"))).toEqual(["a", "b"]);
		expect(ids(model.runOf("c"))).toEqual(["c"]);
		expect(ids(model.runOf("d"))).toEqual(["d"]);
		expect(ids(model.runOf("e"))).toEqual(["e", "f"]);
	});

	it("breaks a run at an assistant message that failed", () => {
		const model = loaded(assistant(call("a")), { role: "assistant", content: [], stopReason: "error" }, assistant(call("b")));
		expect(ids(model.runOf("b"))).toEqual(["b"]);
	});

	it("records which calls failed", () => {
		const model = loaded(assistant(call("a"), call("b")), result("a"), result("b", true));
		expect(model.runOf("a")?.calls.map((c) => c.failed)).toEqual([false, true]);
	});

	it("claims no thinking time it did not measure", () => {
		const run = loaded(assistant(thinking(), call("a"))).runOf("a");
		expect(run?.thinkingUnknown).toBe(true);
		expect(runSummary(run as ToolRun, plain)).toBe("Ran 1 shell command");
	});

	it("closes every run, since nothing in a branch is still running", () => {
		const model = loaded(assistant(call("a")));
		expect(model.isOpen(model.runOf("a") as ToolRun)).toBe(false);
	});
});

describe("runs followed live", () => {
	function live() {
		let now = 0;
		const model = new RunModel();
		const feed = new LiveFeed(model, () => now);
		model.agentStart();
		return { model, feed, at: (t: number) => (now = t) };
	}

	it("stays open while the agent adds to it, and closes when prose starts", () => {
		const { model, feed } = live();
		feed.begin();
		feed.end(assistant(call("a")));
		const run = model.runOf("a") as ToolRun;
		expect(model.isOpen(run)).toBe(true);

		feed.begin();
		const parts = [text("Done")];
		feed.update({ type: "text_delta", contentIndex: 0, delta: "Done" }, parts);
		expect(model.isOpen(run)).toBe(false);
	});

	it("closes when the agent ends", () => {
		const { model, feed } = live();
		feed.begin();
		feed.end(assistant(call("a")));
		model.agentEnd();
		expect(model.isOpen(model.runOf("a") as ToolRun)).toBe(false);
	});

	it("adds a call once the part after it starts, before its message ends", () => {
		const { model, feed } = live();
		feed.begin();
		const parts = [call("a"), call("b")];
		feed.update({ type: "toolcall_start", contentIndex: 1 }, parts);
		expect(ids(model.runOf("a"))).toEqual(["a"]);
		feed.end({ role: "assistant", content: parts, stopReason: "toolUse" });
		expect(ids(model.runOf("a"))).toEqual(["a", "b"]);
	});

	it("does not add a part twice when the message ends", () => {
		const { model, feed } = live();
		feed.begin();
		const parts = [call("a"), text("x")];
		feed.update({ type: "text_delta", contentIndex: 1, delta: "x" }, parts);
		feed.end({ role: "assistant", content: parts, stopReason: "stop" });
		expect(ids(model.runOf("a"))).toEqual(["a"]);
	});

	it("times thinking between its start and end and gives it to the call it led to", () => {
		const { model, feed, at } = live();
		feed.begin();
		const parts = [thinking(), call("a")];
		at(1_000);
		feed.update({ type: "thinking_start", contentIndex: 0 }, parts);
		at(10_400);
		feed.update({ type: "thinking_end", contentIndex: 0 }, parts);
		feed.end({ role: "assistant", content: parts, stopReason: "toolUse" });
		model.agentEnd();
		const run = model.runOf("a") as ToolRun;
		expect(run.thinkingMs).toBe(9_400);
		expect(runSummary(run, plain)).toBe("Thought for 9s, ran 1 shell command");
	});

	it("drops thinking that led to prose rather than to a call", () => {
		const { model, feed, at } = live();
		feed.begin();
		const parts = [thinking(), text("Let me look."), call("a")];
		at(0);
		feed.update({ type: "thinking_start", contentIndex: 0 }, parts);
		at(5_000);
		feed.update({ type: "thinking_end", contentIndex: 0 }, parts);
		feed.end({ role: "assistant", content: parts, stopReason: "toolUse" });
		expect(model.runOf("a")?.thinkingMs).toBe(0);
	});
});

describe("runSummary", () => {
	const run = (calls: Array<[string, boolean?]>, thinkingMs = 0): ToolRun => ({
		id: "0",
		calls: calls.map(([toolName, failed], i) => ({ id: String(i), toolName, failed: failed ?? false })),
		thinkingMs,
		thinkingUnknown: false,
	});

	it("names each kind of call with its count, in a fixed order", () => {
		expect(runSummary(run([["read"], ["bash"], ["grep"], ["bash"], ["find"], ["ls"], ["read"], ["bash"]]), plain)).toBe(
			"Ran 3 shell commands, read 2 files, searched 2 patterns, listed 1 directory",
		);
	});

	it("says how many failed, so a folded run never hides an error", () => {
		expect(runSummary(run([["bash"], ["bash", true]]), plain)).toBe("Ran 2 shell commands (1 failed)");
	});

	it("leaves out thinking under a second", () => {
		expect(runSummary(run([["read"]], 400), plain)).toBe("Read 1 file");
	});

	it("bolds the numbers and dims the rest", () => {
		const themed: UiTheme = { fg: (s, t) => `<${s}>${t}</>`, bold: (t) => `*${t}*`, italic: (t) => t };
		expect(runSummary(run([["bash"]], 2_000), themed)).toBe(
			"<dim>Thought for </>*<dim>2s</>*<dim>, ran </>*<dim>1</>*<dim> shell command</>",
		);
	});

	it("formats long thinking in minutes", () => {
		expect(formatDuration(65_000)).toBe("1m 5s");
		expect(formatDuration(9_400)).toBe("9s");
	});
});

describe("planRow", () => {
	const model = loaded(assistant(call("a"), call("b"), call("c")), result("a"), result("b", true), result("c"));
	const plan = (id: string, open: boolean) => planRow(model, id, () => open);

	it("folds a closed run into its first row, keeping a failed call visible", () => {
		expect(plan("a", false)).toEqual({ header: model.runOf("a"), card: false, inPanel: false });
		expect(plan("b", false)).toEqual({ header: undefined, card: true, inPanel: false });
		expect(plan("c", false)).toEqual({ header: undefined, card: false, inPanel: false });
	});

	it("puts every card of an expanded run on the panel, under the run's line", () => {
		expect(plan("a", true)).toEqual({ header: model.runOf("a"), card: true, inPanel: true });
		expect(plan("c", true)).toEqual({ header: undefined, card: true, inPanel: true });
	});

	it("leaves an open run and calls outside any run as plain cards", () => {
		const live = new RunModel();
		live.agentStart();
		live.addMessage(assistant(call("x")));
		expect(planRow(live, "x", () => false)).toEqual({ card: true, inPanel: false });
		expect(planRow(live, "nope", () => false)).toEqual({ card: true, inPanel: false });
	});
});

describe("GroupState", () => {
	const run = (id: string, ...ids: string[]) => ({
		id,
		calls: [id, ...ids].map((c) => ({ id: c, toolName: "bash", failed: false })),
		thinkingMs: 0,
		thinkingUnknown: false,
	});

	it("follows the global state until a run is clicked", () => {
		const groups = new GroupState();
		expect(groups.isExpanded("r", false)).toBe(false);
		groups.toggle(run("r"), false);
		expect(groups.isExpanded("r", false)).toBe(true);
		expect(groups.isExpanded("other", false)).toBe(false);
	});

	it("lets ctrl+o reset every clicked run to the new global state", () => {
		const groups = new GroupState();
		groups.toggle(run("r"), false);
		expect(groups.isExpanded("r", true)).toBe(true);
		expect(groups.isExpanded("r", false)).toBe(false);
		groups.toggle(run("r"), false);
		groups.toggle(run("r"), false);
		expect(groups.isExpanded("r", false)).toBe(false);
	});

	it("keeps a run shown while a card in it is open, as when watching it run", () => {
		const groups = new GroupState();
		const r = run("r", "s");
		expect(groups.isShown(r, false)).toBe(false);
		groups.setCardOpen("s", true);
		expect(groups.isShown(r, false)).toBe(true);
		groups.setCardOpen("s", false);
		expect(groups.isShown(r, false)).toBe(false);
	});

	it("folds a run held open by a card when its line is clicked, and keeps it folded through repaints", () => {
		const groups = new GroupState();
		const r = run("r", "s");
		groups.setCardOpen("s", true);
		groups.toggle(r, false);
		expect(groups.isShown(r, false)).toBe(false);
		// pi re-renders the still-expanded card: no change, so no reopening.
		groups.setCardOpen("s", true);
		expect(groups.isShown(r, false)).toBe(false);
	});
});
