import { expect, test } from "bun:test";
import { readBatch } from "./state.ts";
import { SYSTEM_PROMPT } from "./engine.ts";

const notice = (id: string, runs: unknown[], content = "") => ({
	id,
	type: "custom_message",
	customType: "subagent-notify",
	timestamp: "2026-10-27T12:00:00Z",
	details: { runs },
	content,
});

test("persisted child notices retain distinct identities and reported outcomes", () => {
	const batch = readBatch(
		[
			notice("a", [
				{
					agent: "reviewer",
					runId: "run-a",
					status: "completed",
					taskInfo: "Review authentication",
				},
			]),
			notice("b", [
				{
					agent: "reviewer",
					runId: "run-b",
					status: "failed",
					taskInfo: "Review storage",
				},
			]),
		],
		"",
	)!;
	expect(batch.events).toHaveLength(2);
	expect(batch.events[0]!.text).toContain("run-a");
	expect(batch.events[0]!.text).toContain("reported completed");
	expect(batch.events[1]!.text).toContain("run-b");
	expect(batch.events[1]!.text).toContain("reported failed");
	expect(batch.to).toBe("b");
	expect(readBatch([notice("a", []), notice("b", [])], "b")).toBeUndefined();
	expect(SYSTEM_PROMPT).toContain(
		"child completion is not verification of the main task",
	);
});

test("a successful subagent dispatch or status call is not child completion", () => {
	const batch = readBatch(
		[
			{
				id: "a",
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					details: { asyncId: "run-a", background: true, results: [] },
					content: [{ type: "text", text: "Started worker" }],
				},
			},
		],
		"",
	)!;
	expect(batch.events[0]!.text).toContain("run-a");
	expect(batch.events[0]!.text).not.toContain("Tool subagent completed");
	expect(batch.events[0]!.text).toContain("completion unknown");
});

test("wait results attribute terminal children without reading private messages or arguments", () => {
	const batch = readBatch(
		[
			{
				id: "a",
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bg_wait",
					details: {
						completions: [
							{
								runId: "workflow-1",
								results: [
									{
										runId: "child-2",
										agent: "tester",
										success: false,
										stopped: true,
										messages: [{ content: "PRIVATE_REASONING" }],
										arguments: { token: "PRIVATE_ARGUMENT" },
									},
								],
							},
						],
					},
					content: [],
				},
			},
		],
		"",
	)!;
	const text = batch.events[0]!.text;
	expect(text).toContain("workflow-1");
	expect(text).toContain("child-2");
	expect(text).toContain("stopped");
	expect(text).not.toContain("PRIVATE_");
});

test("unknown notices and side discussions stay out; oversized child notices stay bounded", () => {
	const entries = [
		{
			id: "private",
			type: "custom_message",
			customType: "btw-chat",
			content: "PRIVATE_SIDE_CHAT",
		},
		{
			id: "unknown",
			type: "custom_message",
			customType: "other",
			content: "PRIVATE_OTHER",
		},
		notice(
			"a",
			Array.from({ length: 50 }, (_, i) => ({
				agent: "worker",
				runId: `run-${i}`,
				status: "paused",
				taskInfo: "x".repeat(9000),
			})),
			"Bearer secret-value",
		),
	];
	const batch = readBatch(entries, "")!;
	expect(batch.events).toHaveLength(1);
	expect(batch.events[0]!.text.length).toBeLessThanOrEqual(480);
	expect(batch.events[0]!.text).toContain("more children omitted");
	expect(JSON.stringify(batch)).not.toContain("PRIVATE_");
	expect(JSON.stringify(batch)).not.toContain("secret-value");
});

test("workflow notices retain nested child identities and visible single-child results", () => {
	const batch = readBatch(
		[
			notice("workflow", [
				{
					agent: "workflow",
					runId: "parent-1",
					status: "completed",
					childRuns: [
						{ agent: "reviewer", runId: "child-a", status: "completed" },
						{ agent: "reviewer", runId: "child-b", status: "stopped" },
					],
				},
			]),
			notice(
				"result",
				[{ agent: "reviewer", runId: "child-c", status: "completed" }],
				"Found a race condition. Bearer private-token",
			),
		],
		"",
	)!;
	expect(batch.events[0]!.text).toContain("child-a");
	expect(batch.events[0]!.text).toContain("child-b");
	expect(batch.events[0]!.text).toContain("parent-1");
	expect(batch.events[1]!.text).toContain("Found a race condition");
	expect(batch.events[1]!.text).not.toContain("private-token");
});
