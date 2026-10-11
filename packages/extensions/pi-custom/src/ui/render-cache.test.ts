import { describe, expect, it } from "bun:test";
import { DEFAULTS } from "./config.ts";
import { GroupState, RunModel } from "./group.ts";
import { HoverTracker } from "./hover.ts";
import { cardRenderers, type RendererDeps, type RenderContextLike } from "./render.ts";

function fixture() {
	const config = { ...DEFAULTS, groupRuns: false, collapsedLines: 1 };
	const model = new RunModel();
	const groups = new GroupState();
	const hover = new HoverTracker();
	let highlights = 0;
	let colour = "";
	const theme = { fg: (_: string, text: string) => colour + text, bold: (text: string) => text, italic: (text: string) => text };
	const deps: RendererDeps = {
		config: () => ({ ...config }),
		highlight: (code) => { highlights++; return code.split("\n"); },
		languageOf: () => undefined,
		expandKey: () => "ctrl+o",
		runs: { model, groups, toolsExpanded: () => false },
		hover,
	};
	const renderer = cardRenderers("read", deps);
	const context: RenderContextLike = { args: { path: "a.ts" }, toolCallId: "a", state: {}, cwd: "/repo", expanded: false, isPartial: false, isError: false };
	const result = { content: [{ type: "text", text: "one\ntwo\nthree" }] };
	const update = () => renderer.renderResult!(result, { expanded: context.expanded, isPartial: context.isPartial }, theme, context);
	update();
	const card = renderer.renderCall!(context.args, theme, context);
	return { card, config, context, result, update, renderer, theme, model, groups, hover, highlights: () => highlights, colour: (value: string) => { colour = value; } };
}

describe("tool card render caching", () => {
	it("reuses unchanged lines without highlighting again, including equivalent config objects", () => {
		const f = fixture();
		const lines = f.card.render(60);
		for (let i = 0; i < 10; i++) expect(f.card.render(60)).toBe(lines);
		expect(f.highlights()).toBe(1);
	});

	it("invalidates on resize, configuration and theme changes", () => {
		const f = fixture();
		const wide = f.card.render(60);
		expect(f.card.render(15)).not.toBe(wide);
		const narrow = f.card.render(15);
		f.config.collapsedLines = 3;
		expect(f.card.render(15)).not.toEqual(narrow);
		f.colour("new-theme:");
		f.card.invalidate();
		expect(f.card.render(60).join("\n")).toContain("new-theme:");
	});

	it("observes partial results mutated in place, completion, errors and expansion", () => {
		const f = fixture();
		f.card.render(60);
		f.result.content[0].text = "changed\nsecond\nthird";
		f.context.isPartial = true;
		f.update();
		const pending = f.card.render(60);
		f.context.isPartial = false;
		f.update();
		expect(f.card.render(60)).not.toEqual(pending);
		expect(f.card.render(60).join("\n")).toContain("changed");
		f.context.expanded = true;
		f.update();
		expect(f.card.render(60).join("\n")).toContain("third");
		f.context.isError = true;
		f.result.content[0].text = "failure";
		f.update();
		expect(f.card.render(60).join("\n")).toContain("failure");
	});

	it("reuses Pi's lastComponent and accepts in-place argument updates", () => {
		const f = fixture();
		f.card.render(60);
		(f.context.args as { path: string }).path = "b.ts";
		const card = f.renderer.renderCall!(f.context.args, f.theme, { ...f.context, lastComponent: f.card });
		expect(card).toBe(f.card);
		expect(card.render(60).join("\n")).toContain("b.ts");
	});

	it("keeps a finished run cached while an unrelated run changes", () => {
		const f = fixture();
		f.config.groupRuns = true;
		f.model.addPart({ type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } });
		f.model.agentEnd();
		const lines = f.card.render(60);
		f.model.agentStart();
		f.model.addPart({ type: "toolCall", id: "other", name: "read", arguments: { path: "other.ts" } });
		expect(f.card.render(60)).toBe(lines);
		f.model.setFailed("other", true);
		expect(f.card.render(60)).toBe(lines);
	});

	it("updates a cached live activity line when execution supplies new arguments", () => {
		const f = fixture();
		f.config.groupRuns = true;
		f.model.agentStart();
		f.model.addPart({ type: "toolCall", id: "a", name: "read", arguments: { path: "old.ts" } });
		expect(f.card.render(60).join("\n")).toContain("old.ts");
		f.model.started("a", { path: "new.ts" });
		expect(f.card.render(60).join("\n")).toContain("new.ts");
	});

	it("tracks hover entry and exit without changing the underlying result", () => {
		const f = fixture();
		const plain = f.card.render(60);
		f.hover.claim("card:a", () => {});
		expect(f.card.render(60)).not.toEqual(plain);
		f.hover.clear();
		expect(f.card.render(60)).toEqual(plain);
	});

	it("tracks live run growth, failures, closing and group expansion", () => {
		const f = fixture();
		f.config.groupRuns = true;
		f.model.agentStart();
		const add = (id: string) => f.model.addPart({ type: "toolCall", id, name: "read", arguments: { path: id } });
		add("a");
		const first = f.card.render(60);
		expect(f.card.render(60)).toBe(first);
		add("b");
		expect(f.card.render(60).join("\n")).toContain("2 files");
		f.model.setFailed("b", true);
		expect(f.card.render(60).join("\n")).toContain("1 failed");
		f.model.agentEnd();
		expect(f.card.render(60).join("\n")).not.toContain("Reading");
		f.groups.toggle(f.model.runOf("a")!, false);
		expect(f.card.render(60).join("\n")).toContain("one");
		f.groups.toggle(f.model.runOf("a")!, false);
		expect(f.card.render(60)).toHaveLength(1);
	});
});
