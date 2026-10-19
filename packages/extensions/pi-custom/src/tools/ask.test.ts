import { expect, test } from "bun:test";
import { registerAsk } from "./ask.ts";

const questions = [{
	question: "May I edit the overlay without pushing?", header: "Scope",
	options: [{ label: "Approve", description: "Edit and format only." }, { label: "No", description: "Do not edit." }],
}];

function harness(pick: boolean) {
	let tool: { execute: Function };
	const entries: { type: string; data: unknown }[] = [];
	const events: string[] = [];
	registerAsk({
		on() {},
		registerTool: (value: typeof tool) => { tool = value; },
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		events: { emit: (name: string) => events.push(name) },
	} as never);
	const ctx = { hasUI: true, mode: "rpc", ui: { select: async (_title: string, options: string[]) => pick ? options[0] : undefined } };
	return { run: () => tool.execute("q1", { questions }, undefined, undefined, ctx), entries, events };
}

test("a submitted questionnaire records its scope and notifies the permission owner", async () => {
	const h = harness(true);
	await h.run();
	expect(h.entries).toEqual([{ type: "pi-user-decision", data: expect.objectContaining({ version: 1, source: "questionnaire", toolCallId: "q1", questions, cancelled: false }) }]);
	expect(h.events).toEqual(["pi-user-decision:submitted"]);
});

test("a cancelled questionnaire produces neither authority nor a submission event", async () => {
	const h = harness(false);
	await h.run();
	expect(h.entries).toEqual([]);
	expect(h.events).toEqual([]);
});
