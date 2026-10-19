import { expect, test } from "bun:test";
import { registerGoal } from "./goal.ts";

function harness() {
	const handlers = new Map<string, Function>();
	registerGoal({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerTool() {}, registerCommand() {}, appendEntry() {}, sendMessage() {},
	} as never, () => ({ goalTurnLimit: 0, goalNoProgressTurns: 0 }) as never);
	return handlers;
}

test("background completion can start a run with no prompt and no active goal", () => {
	const h = harness();
	expect(() => h.get("before_agent_start")!({ type: "before_agent_start" })).not.toThrow();
});

test("background completion still receives the active goal contract", () => {
	const h = harness();
	h.get("session_start")!({}, {
		ui: { setStatus() {} },
		sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-state", data: { goal: {
			id: "active-goal", text: "Verify the fix", status: "active", iteration: 0, tokensUsed: 0,
		} } }] },
	});
	const result = h.get("before_agent_start")!({ type: "before_agent_start" });
	expect(result.message.content).toContain("active-goal");
	expect(result.message.content).toContain("Verify the fix");
});
