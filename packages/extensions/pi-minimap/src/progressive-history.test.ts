import { expect, test } from "bun:test";
import { applySummary, emptySnapshot, historyCompaction, HISTORY_LEVELS, HISTORY_LIMIT, parseSummary, restore, restoreUsage, STATE_TYPE } from "./state.ts";

test("thousands of updates keep bounded, continuous source coverage at progressively coarser ages", () => {
	const state = emptySnapshot();
	for (let i = 0; i < 3000; i++) {
		applySummary(state, { from: `e${i}`, to: `e${i}`, events: [], omitted: 0 }, parseSummary(JSON.stringify({
			beat: `Event ${i}`, tone: "neutral", now: "Working", folded: `Folded group ${i}`, compact: `Older group ${i}`,
		}), state.recent.length >= 6, !!historyCompaction(state.history)), false);
		expect(state.history.length).toBeLessThanOrEqual(HISTORY_LIMIT);
		expect(state.recent.length).toBeLessThanOrEqual(6);
		if (i % 100 === 0 || i === 2999) {
			let next = 0;
			for (const beat of [...state.history, ...state.recent]) {
				expect(beat.from).toBe(`e${next}`);
				next = Number(beat.to.slice(1)) + 1;
			}
			expect(next).toBe(i + 1);
			expect(state.history.map(item => item.level)).toEqual(state.history.map(item => item.level).sort((a, b) => b! - a!));
		}
	}
	expect(state.history.length).toBeGreaterThan(8);
	expect(new Set(state.history.map(item => item.level))).toEqual(new Set([1, 2, 3, 4]));
	expect(state.history[0]?.from).toBe("e0");
	expect(state.history[0]?.level).toBe(HISTORY_LEVELS);
	expect(state.recent.at(-1)?.to).toBe("e2999");
});

test("compression changes only its selected group, retaining source spans and sampling notices", () => {
	const state = emptySnapshot();
	state.history = Array.from({ length: 6 }, (_, i) => ({ text: `Old ${i}`, tone: "neutral" as const, from: `e${i * 3}`, to: `e${i * 3 + 2}`, level: 1, recap: i === 1, omitted: i === 1 ? 12 : undefined }));
	state.recent = Array.from({ length: 6 }, (_, i) => ({ text: `Recent ${i}`, tone: "neutral" as const, from: `e${18 + i}`, to: `e${18 + i}` }));
	const kept = state.history.slice(3);
	expect(historyCompaction(state.history)).toEqual({ indices: [0, 1, 2], level: 2 });
	applySummary(state, { from: "e24", to: "e24", events: [], omitted: 0 }, parseSummary(JSON.stringify({ beat: "New", tone: "neutral", now: "Working", folded: "Recent group", compact: "Older group" }), true, true), false);
	expect(state.history[0]).toMatchObject({ from: "e0", to: "e8", level: 2, text: "Older group", recap: true, omitted: 12 });
	expect(state.history.slice(1, 4)).toEqual(kept);
	expect(state.history.at(-1)).toMatchObject({ from: "e18", to: "e20", level: 1, text: "Recent group" });
});

test("v1 snapshots migrate complete older text and usage into the continuous v2 history", () => {
	const usage = { ...emptySnapshot().usage, requests: 2, input: 200, output: 30 };
	const legacy = { ...emptySnapshot(), version: 1, lastId: "new", usage, usageSessionId: "session", earlier: {
		text: "Legacy opening", bullets: ["First complete decision.", "Second complete result.", "Third unresolved blocker."], tone: "neutral", from: "old", to: "old",
	}, chapters: [{ text: "Middle history", tone: "neutral", from: "middle", to: "middle" }], recent: [{ text: "Newest", tone: "neutral", from: "new", to: "new" }] };
	const branch = [{ id: "old" }, { id: "middle" }, { id: "new" }, { type: "custom", customType: STATE_TYPE, data: legacy }];
	const migrated = restore(branch);
	expect(migrated.version).toBe(2);
	expect(migrated.history.map(item => item.level)).toEqual([4, 1]);
	expect(migrated.history[0]?.text).toBe(legacy.earlier.bullets.join(" "));
	expect(migrated.recent[0]?.text).toBe("Newest");
	const saved = { type: "custom", customType: STATE_TYPE, data: { ...migrated, usageSessionId: "session" } };
	expect(restore([...branch, saved])).toEqual(migrated);
	expect(restoreUsage([...branch, saved], "session")).toEqual(usage);
	expect(restoreUsage([...branch, saved], "different-session")).toEqual(emptySnapshot().usage);
});

test("restoration rejects over-cap, invalid-level and out-of-branch history", () => {
	for (const history of [
		Array.from({ length: HISTORY_LIMIT + 1 }, () => ({ text: "x", tone: "neutral", from: "a", to: "a", level: 1 })),
		[{ text: "x", tone: "neutral", from: "a", to: "a", level: HISTORY_LEVELS + 1 }],
		[{ text: "x", tone: "neutral", from: "missing", to: "a", level: 1 }],
	]) {
		const restored = restore([{ id: "a" }, { type: "custom", customType: STATE_TYPE, data: { ...emptySnapshot(), now: "Invalid state", history } }]);
		expect(restored.now).toBe("");
		expect(restored.history).toEqual([]);
	}
});

test("required compression text cannot become empty when terminal controls are stripped", () => {
	for (const field of ["folded", "compact"]) {
		expect(() => parseSummary(JSON.stringify({ beat: "New result", now: "Working", tone: "neutral", folded: "Recent group", compact: "Older group", [field]: "\x1b\x07" }), true, true)).toThrow("Invalid minimap summary");
	}
});
