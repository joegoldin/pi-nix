import { describe, expect, it } from "bun:test";
import {
	activeContract,
	CONTINUATION_MARKER,
	continuationPrompt,
	contradictsCompletion,
	fingerprint,
	formatTokens,
	type Goal,
	kickoffPrompt,
	parseBudget,
	parseCommand,
	statusText,
} from "./goal-text.ts";

const goal = (over: Partial<Goal> = {}): Goal => ({
	id: "g-1",
	text: "Make the tests pass",
	status: "active",
	startedAt: 0,
	updatedAt: 0,
	iteration: 3,
	tokensUsed: 1500,
	baselineTokens: 0,
	timeUsedSeconds: 90,
	automaticModelTurns: 2,
	toolFreeRepeatCount: 0,
	...over,
});

describe("the command", () => {
	it("starts a goal, with or without a budget", () => {
		expect(parseCommand("fix the build")).toEqual({ kind: "start", objective: "fix the build", budget: undefined });
		expect(parseCommand("--tokens 100k fix it")).toEqual({ kind: "start", objective: "fix it", budget: 100_000 });
	});

	it("knows its verbs and refuses arguments to them", () => {
		expect(parseCommand("pause")).toEqual({ kind: "pause" });
		expect(parseCommand("stop")).toEqual({ kind: "clear" });
		expect(parseCommand("resume now")).toEqual({ kind: "error", message: "Usage: /goal resume" });
		expect(parseCommand("")).toEqual({ kind: "show" });
	});

	it("edits with an optional new budget", () => {
		expect(parseCommand("edit --tokens 2m do more")).toEqual({ kind: "edit", objective: "do more", budget: 2_000_000 });
	});

	it("turns away a bad budget and an objective that should be a file", () => {
		expect(parseCommand("--tokens lots x").kind).toBe("error");
		const long = parseCommand("x".repeat(4001));
		expect(long.kind === "error" && long.message).toContain("Put long instructions in a file");
	});

	it("reads budgets the way people write them", () => {
		expect(parseBudget("25k")).toBe(25_000);
		expect(parseBudget("1.5M")).toBe(1_500_000);
		expect(parseBudget("0")).toBeUndefined();
	});
});

describe("prompts", () => {
	it("carries the objective as data and the id as a guard", () => {
		const p = kickoffPrompt(goal({ text: "a <b> & c" }));
		expect(p).toStartWith("Goal mode is active. Complete this goal fully:");
		expect(p).toContain("<goal_objective>\na &lt;b&gt; &amp; c\n</goal_objective>");
		expect(p).toContain("<goal_id>\ng-1\n</goal_id>");
		expect(p).toContain("Keep working until this goal is completely resolved end-to-end.");
	});

	it("marks a continuation so the loop knows its own prompt", () => {
		expect(continuationPrompt(goal(), "n1")).toEndWith(`<!-- ${CONTINUATION_MARKER}:g-1:3:n1 -->`);
	});

	it("keeps the contract free of counters, so it stays the same between turns", () => {
		expect(activeContract(goal({ iteration: 1 }))).toBe(activeContract(goal({ iteration: 9, tokensUsed: 9999 })));
	});
});

describe("completion claims", () => {
	it("rejects a summary that admits the work is unfinished", () => {
		expect(contradictsCompletion("Mostly done but not yet complete")).toBe(true);
		expect(contradictsCompletion("tests still failing on CI")).toBe(true);
		expect(contradictsCompletion("All 40 tests pass; build is green")).toBe(false);
		expect(contradictsCompletion("It could not complete earlier, now fixed")).toBe(false);
	});
});

describe("the no-progress fingerprint", () => {
	it("treats rewordings of whitespace and case as the same reply", () => {
		expect(fingerprint("Still  Working")).toBe(fingerprint("still working"));
		expect(fingerprint("...")).toBe(fingerprint(""));
		expect(fingerprint("a")).not.toBe(fingerprint("b"));
	});
});

describe("status", () => {
	it("shows progress against the turn limit and the budget", () => {
		expect(statusText(goal(), 25)).toBe("active 1m · automatic 2/25");
		expect(statusText(goal({ tokenBudget: 100_000 }), 25)).toBe("active 1.5k/100k · automatic 2/25");
		expect(statusText(goal({ waiting: { reason: "CI" } }), null)).toBe("waiting CI · automatic Unlimited");
		expect(statusText(undefined, 25)).toBeUndefined();
	});

	it("formats token counts compactly", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1000)).toBe("1k");
		expect(formatTokens(1_500_000)).toBe("1.5m");
	});
});
