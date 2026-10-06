import { describe, expect, it } from "bun:test";
import { duration, summaryText } from "./turn-text.ts";

describe("duration", () => {
	it("keeps the two largest units", () => {
		expect(duration(6_000)).toBe("6s");
		expect(duration(72_000)).toBe("1m 12s");
		expect(duration(120_000)).toBe("2m");
		expect(duration(3_780_000)).toBe("1h 3m");
		expect(duration(3_600_000)).toBe("1h");
	});
});

describe("summaryText", () => {
	const at = Date.UTC(2026, 9, 6, 18, 11);
	it("reads like Claude Code's, without the verbs", () => {
		expect(summaryText({ elapsedMs: 57_000, doneAt: at, shells: 1, failed: false }, "en-US", "UTC")).toBe(
			"✓ 57s · done 6:11 PM · 1 shell still running",
		);
	});

	it("leaves out shells when none run, and marks a failed run", () => {
		expect(summaryText({ elapsedMs: 6_000, doneAt: at, shells: 0, failed: true }, "en-US", "UTC")).toBe("✗ 6s · done 6:11 PM");
		expect(summaryText({ elapsedMs: 6_000, doneAt: at, shells: 2, failed: false }, "en-US", "UTC")).toContain("2 shells still running");
	});
});
