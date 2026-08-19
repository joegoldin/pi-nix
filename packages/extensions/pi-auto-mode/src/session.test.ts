import { describe, expect, it } from "bun:test";
import { recentUserTurns } from "./session.ts";

const branch = [
	{ type: "message", message: { role: "user", content: "first thing" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
	{ type: "model_change", provider: "anthropic", modelId: "x" },
	{
		type: "message",
		message: {
			role: "user",
			content: [
				{ type: "text", text: "yes " },
				{ type: "image", data: "..." },
				{ type: "text", text: "delete it" },
			],
		},
	},
	{ type: "message", message: { role: "user", content: "  " } },
];

describe("recentUserTurns", () => {
	it("returns user turns oldest-first, flattening text content blocks", () => {
		expect(recentUserTurns({ getBranch: () => branch }, 10)).toEqual(["first thing", "yes delete it"]);
	});

	it("keeps only the most recent `limit` turns", () => {
		expect(recentUserTurns({ getBranch: () => branch }, 1)).toEqual(["yes delete it"]);
	});

	it("drops whitespace-only turns", () => {
		expect(recentUserTurns({ getBranch: () => branch }, 10)).not.toContain("");
	});

	it("returns an empty array when the session manager throws", () => {
		expect(
			recentUserTurns(
				{
					getBranch: () => {
						throw new Error("no session");
					},
				},
				5,
			),
		).toEqual([]);
	});

	it("returns an empty array for a non-positive limit", () => {
		expect(recentUserTurns({ getBranch: () => branch }, 0)).toEqual([]);
	});
});
