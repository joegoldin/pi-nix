import { describe, expect, it } from "bun:test";
import { restoredQueue, wasAborted } from "./steer.ts";

describe("restoredQueue", () => {
	it("is everything pi restored when there was no draft", () => {
		expect(restoredQueue("fix the test\n\nthen push", "")).toBe("fix the test\n\nthen push");
	});

	it("is the part in front of the draft", () => {
		expect(restoredQueue("queued one\n\nhalf-typed", "half-typed")).toBe("queued one");
	});

	it("refuses an editor in any other shape", () => {
		expect(restoredQueue("something else", "half-typed")).toBeUndefined();
		expect(restoredQueue("half-typed", "half-typed")).toBeUndefined();
		expect(restoredQueue("   ", "")).toBeUndefined();
	});
});

describe("wasAborted", () => {
	it("knows both ways pi records an Esc abort", () => {
		expect(wasAborted({ stopReason: "aborted" })).toBe(true);
		expect(wasAborted({ stopReason: "error", errorMessage: "The operation was aborted." })).toBe(true);
		expect(wasAborted({ stopReason: "error", errorMessage: "rate limited" })).toBe(false);
		expect(wasAborted({ stopReason: "stop" })).toBe(false);
	});
});
