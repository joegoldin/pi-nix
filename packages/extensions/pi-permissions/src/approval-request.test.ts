import { expect, it } from "bun:test";
import { registerApprovalRequest, denialGuidance } from "./approval-request.ts";
import { PermissionLedger } from "./denials.ts";

function setup(answer = "allow-session") {
	const ledger = new PermissionLedger();
	const input = { command: "cd /tmp/worktree && python3 update.py" };
	const denial = ledger.record({ toolCallId: "blocked", toolName: "bash", input, reason: "Needs authorization", cwd: "/tmp/main", sessionId: "session", review: { eligible: true, response: "timeout" }, directories: [{ path: "/tmp/worktree", access: "read" }] });
	let tool: any;
	let asked = 0;
	let saveCount = 0;
	let prompt: any;
	const events: { channel: string; data: any }[] = [];
	const pi = { registerTool(t: any) { tool = t; }, events: { emit(channel: string, data: unknown) { events.push({ channel, data }); if (channel === "pi-user-decision:submitted") ledger.clearSimilar(); } } };
	const ctx = { hasUI: true, mode: "tui", cwd: "/tmp/main", sessionManager: { getSessionId: () => "session" } };
	let respond = async () => answer;
	registerApprovalRequest(pi as never, ledger, () => saveCount++, async (_ctx, ask) => { asked++; prompt = ask; return await respond() as never; });
	const call = (id = denial.id, signal = new AbortController().signal) => tool.execute("review", { denialId: id }, signal, undefined, ctx);
	return { ledger, denial, input, ctx, call, events, setResponse(fn: () => Promise<string>) { respond = fn; }, asked: () => asked, saves: () => saveCount, prompt: () => prompt };
}

it("links a real user answer to the displayed denial without a second menu approval", async () => {
	const h = setup();
	const result = await h.call();
	expect(result.details.status).toBe("approved");
	expect(h.asked()).toBe(1);
	expect(h.prompt()).toMatchObject({ input: h.input, scopeOnly: true, title: `Review denial ${h.denial.id}` });
	expect(h.prompt().scope).toContain("Command scope:");
	expect(h.prompt().scope).toContain("Read-only access under /tmp/worktree");
	expect(h.denial.state).toBe("approved");
	expect(h.events.map(e => e.channel)).toEqual(["permissions:ui_prompt", "pi-user-decision:submitted", "permissions:decision"]);
	expect(h.events[0]!.data.requestId).toBe(h.events[2]!.data.requestId);
	expect(h.events[2]!.data.result).toBe("allow");
	expect(h.ledger.isSimilarlyGranted("bash", h.input, "/tmp/main")).toBe(true);
	expect(h.ledger.isGranted("bash", h.input)).toBe(false);
	expect(h.ledger.directoryApprovals()).toMatchObject([{ access: "read" }]);
	await h.call();
	expect(h.asked()).toBe(1);
});

for (const answer of ["deny", "timeout", "allow"]) it(`does not grant on ${answer} or repeatedly prompt`, async () => {
	const h = setup(answer);
	expect((await h.call()).details.status).not.toBe("approved");
	expect(h.ledger.grantList()).toEqual([]);
	await h.call();
	expect(h.asked()).toBe(1);
});

it("refuses unknown, hard, rejected, child-owned and headless requests without prompting", async () => {
	for (const change of [
		(h: ReturnType<typeof setup>) => { h.denial.review!.eligible = false; },
		(h: ReturnType<typeof setup>) => { h.denial.review!.response = "denied"; },
		(h: ReturnType<typeof setup>) => { delete h.denial.review; },
		(h: ReturnType<typeof setup>) => { h.denial.policyDenied = true; },
		(h: ReturnType<typeof setup>) => { h.denial.owner = { sessionId: "child", agentName: "worker", cwd: "/tmp/main" }; },
		(h: ReturnType<typeof setup>) => { h.ctx.hasUI = false; },
		(h: ReturnType<typeof setup>) => { h.ctx.cwd = "/tmp/other"; },
		(h: ReturnType<typeof setup>) => { h.denial.sessionId = "parent-session-before-fork"; },
	]) {
		const h = setup(); change(h);
		expect((await h.call()).details.status).not.toBe("approved");
		expect(h.asked()).toBe(0);
		expect(h.ledger.grantList()).toEqual([]);
	}
	const h = setup(); await h.call("unknown"); expect(h.asked()).toBe(0);
});

it("rechecks cancellation and branch identity after the UI resolves", async () => {
	for (const cancel of [true, false]) {
		const h = setup();
		const controller = new AbortController();
		h.setResponse(async () => { if (cancel) controller.abort(); else h.ledger.restore(h.ledger.snapshot()); return "allow-session"; });
		expect((await h.call(h.denial.id, controller.signal)).details.status).not.toBe("approved");
		expect(h.ledger.grantList()).toEqual([]);
	}
});

it("guides goal runs away from duplicate questions and into waiting only at a real blocker", () => {
	const h = setup();
	const text = denialGuidance(h.denial);
	expect(text).toContain(h.denial.id);
	expect(text).toContain("Do not routinely ask again");
	expect(text).toContain("Independent work");
	expect(text).toContain("only if");
	expect(text).toContain("goal_wait");
	h.denial.review!.response = "denied";
	expect(denialGuidance(h.denial)).toContain("explicitly declined");
	expect(denialGuidance(h.denial)).not.toContain("ask_for_approval");
});

it("does not approve changed arguments or open concurrent duplicate questions", async () => {
	const changed = setup();
	changed.setResponse(async () => { changed.input.command = "different action"; return "allow-session"; });
	expect((await changed.call()).details.status).toBe("stale");
	expect(changed.ledger.grantList()).toEqual([]);
	const h = setup();
	let finish!: (answer: string) => void;
	h.setResponse(() => new Promise(resolve => { finish = resolve; }));
	const first = h.call();
	expect((await h.call()).details.status).toBe("unavailable");
	expect(h.asked()).toBe(1);
	finish("allow-session");
	expect((await first).details.status).toBe("approved");
});
