import { describe, expect, it } from "bun:test";
import type { UiTheme } from "./card.ts";
import {
	type EntryLike,
	foldsCall,
	formatDuration,
	GroupState,
	LiveFeed,
	type MessageLike,
	planRow,
	RunModel,
	runSummary,
	thoughtLines,
	type ToolRun,
} from "./group.ts";

const plain: UiTheme = { fg: (_s, t) => t, bold: (t) => t, italic: (t) => t };

const call = (id: string, name = "bash", args: object = name === "bash" ? { command: "ls" } : { path: "a.ts" }) => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
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

	it("breaks a run on a shell command that does something, and leaves it out", () => {
		const model = loaded(assistant(call("a"), call("m", "bash", { command: "mkdir -p x && echo hi > x/f" }), call("b", "bash", { command: "git log" })));
		expect(model.runOf("m")).toBeUndefined();
		expect(ids(model.runOf("a"))).toEqual(["a"]);
		expect(ids(model.runOf("b"))).toEqual(["b"]);
	});

	it("keeps each call's arguments and the thinking that led to it", () => {
		const model = loaded(
			assistant(thinking("**Looking around**"), call("a")),
			assistant(thinking("**Reading config**"), thinking("more"), call("b", "read", { path: "c.json" })),
		);
		const run = model.runOf("a") as ToolRun;
		expect(run.calls.map((c) => c.thinking)).toEqual([["**Looking around**"], ["**Reading config**", "more"]]);
		expect(run.calls[1].args).toEqual({ path: "c.json" });
	});

	it("drops thinking that led to prose", () => {
		const model = loaded(assistant(thinking("why"), text("Here."), call("a")));
		expect(model.runOf("a")?.calls[0].thinking).toEqual([]);
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

	it("counts the calls of an aborted message as failed, as pi draws them", () => {
		const model = loaded(assistant(call("a")), { role: "assistant", content: [call("b")], stopReason: "aborted" });
		expect(model.runOf("b")?.calls.map((c) => c.failed)).toEqual([false, true]);
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

	it("adds a call as soon as its arguments are complete", () => {
		const { model, feed } = live();
		feed.begin();
		const parts = [call("a")];
		feed.update({ type: "toolcall_start", contentIndex: 0 }, parts);
		expect(model.runOf("a")).toBeUndefined();
		feed.update({ type: "toolcall_end", contentIndex: 0 }, parts);
		expect(ids(model.runOf("a"))).toEqual(["a"]);
	});

	it("takes the arguments a call starts with", () => {
		const { model, feed } = live();
		feed.begin();
		feed.end(assistant(call("a")));
		model.started("a", { command: "ls -la" });
		expect(model.runOf("a")?.calls[0].args).toEqual({ command: "ls -la" });
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

describe("thinking left to the run", () => {
	it("hides a message's thinking when every call in it folds and it has no prose", () => {
		const model = loaded(assistant(thinking(), call("a"), call("b", "read")));
		expect(model.hidesThinking(assistant(thinking(), call("a"), call("b", "read")))).toBe(true);
	});

	it("keeps thinking before prose, before a call that stands alone, or with nothing to hide", () => {
		const withText = assistant(thinking(), text("Found it."), call("a"));
		const withEdit = assistant(thinking(), call("a"), call("e", "edit"));
		const noThinking = assistant(call("a"));
		const model = loaded(withText, withEdit, noThinking);
		expect(model.hidesThinking(withText)).toBe(false);
		expect(model.hidesThinking(withEdit)).toBe(false);
		expect(model.hidesThinking(noThinking)).toBe(false);
		expect(model.hidesThinking(assistant(thinking()))).toBe(false);
	});

	it("holds thinking back while the agent works, until something says it belongs to no run", () => {
		const model = new RunModel();
		model.agentStart();
		// Thinking alone so far, then a call still streaming in.
		expect(model.hidesThinking(assistant(thinking()))).toBe(true);
		expect(model.hidesThinking(assistant(thinking(), call("a")))).toBe(true);
		expect(model.hidesThinking(assistant(thinking(), call("w", "write")))).toBe(false);
		model.addMessage(assistant(thinking(), call("m", "bash", { command: "make" })));
		expect(model.hidesThinking(assistant(thinking(), call("m", "bash", { command: "make" })))).toBe(false);
		model.agentEnd();
		expect(model.hidesThinking(assistant(thinking()))).toBe(false);
	});
});

describe("foldsCall", () => {
	it("folds the read-only tools always and bash only when it inspects", () => {
		expect(foldsCall("read", {})).toBe(true);
		expect(foldsCall("grep", {})).toBe(true);
		expect(foldsCall("bash", { command: "rg foo | head" })).toBe(true);
		expect(foldsCall("bash", { command: "npm install" })).toBe(false);
		expect(foldsCall("bash", {})).toBe(false);
		expect(foldsCall("edit", {})).toBe(false);
	});
});

describe("thoughtLines", () => {
	it("strips the bold from title-only thinking and keeps the rest as written", () => {
		expect(thoughtLines(["**Checking close cleanup**\n\n**Reading tests**"])).toEqual(["Checking close cleanup", "Reading tests"]);
		expect(thoughtLines(["**Checking**", "**Reading**"])).toEqual(["Checking", "Reading"]);
		expect(thoughtLines(["The **config** is wrong."])).toEqual(["The **config** is wrong."]);
	});

	it("keeps a blank row between paragraphs of fuller thinking", () => {
		expect(thoughtLines(["First idea.\n\nSecond idea."])).toEqual(["First idea.", "", "Second idea."]);
		expect(thoughtLines(["**Checking**", "It reads the config."])).toEqual(["Checking", "", "It reads the config."]);
		expect(thoughtLines(["One line\nand its next.\n\n\n\nAnother."])).toEqual(["One line", "and its next.", "", "Another."]);
		expect(thoughtLines(["", "  "])).toEqual([]);
	});
});

describe("runSummary", () => {
	const run = (calls: Array<[string, boolean?]>, thinkingMs = 0): ToolRun => ({
		id: "0",
		calls: calls.map(([toolName, failed], i) => ({ id: String(i), toolName, failed: failed ?? false, args: {}, thinking: [] })),
		thinkingMs,
		thinkingUnknown: false,
	});

	it("is in the present tense while the run is open", () => {
		expect(runSummary(run([["bash"], ["read"], ["bash"], ["bash"]], 12_000), plain, false, true)).toBe(
			"Thinking for 12s, running 3 shell commands, reading 1 file…",
		);
		expect(runSummary(run([["ls"]]), plain, false, true)).toBe("Listing 1 directory…");
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
	const model = loaded(assistant(thinking("**Look**"), call("a"), call("b"), call("c")), result("a"), result("b", true), result("c"));
	const plan = (id: string, open: boolean) => planRow(model, id, "bash", () => open);

	it("folds a closed run into its first row, keeping a failed call visible", () => {
		expect(plan("a", false)).toEqual({ header: model.runOf("a"), live: false, card: false, inPanel: false, thinking: undefined });
		expect(plan("b", false)).toEqual({ header: undefined, live: false, card: true, inPanel: false, thinking: undefined });
		expect(plan("c", false)).toEqual({ header: undefined, live: false, card: false, inPanel: false, thinking: undefined });
	});

	it("puts every card of an expanded run on the panel, under the run's line, with its thinking", () => {
		expect(plan("a", true)).toEqual({ header: model.runOf("a"), live: false, card: true, inPanel: true, thinking: ["**Look**"] });
		expect(plan("c", true)).toEqual({ header: undefined, live: false, card: true, inPanel: true, thinking: [] });
	});

	it("folds an open run too, its line live", () => {
		const live = new RunModel();
		live.agentStart();
		live.addMessage(assistant(call("x"), call("y")));
		expect(planRow(live, "x", "bash", () => false)).toMatchObject({ header: live.runOf("x"), live: true, card: false });
		expect(planRow(live, "y", "bash", () => false)).toMatchObject({ header: undefined, card: false });
	});

	it("draws nothing for a call still streaming in that may join a run, and a card for one that cannot", () => {
		const live = new RunModel();
		live.agentStart();
		expect(planRow(live, "p", "bash", () => false)).toEqual({ card: false, inPanel: false });
		expect(planRow(live, "e", "edit", () => false)).toEqual({ card: true, inPanel: false });
		live.addMessage(assistant(call("p", "bash", { command: "rm x" })));
		expect(planRow(live, "p", "bash", () => false)).toEqual({ card: true, inPanel: false });
		// Once the agent stops, nothing is still streaming.
		live.agentEnd();
		expect(planRow(live, "nope", "bash", () => false)).toEqual({ card: true, inPanel: false });
	});
});

describe("GroupState", () => {
	const run = (id: string, ...ids: string[]) => ({
		id,
		calls: [id, ...ids].map((c) => ({ id: c, toolName: "bash", failed: false, args: {}, thinking: [] })),
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
