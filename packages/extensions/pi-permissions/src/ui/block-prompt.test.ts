import { describe, expect, it, spyOn } from "bun:test";
import { BlockPrompt } from "./block-prompt-state.ts";
import { BlockPromptView } from "./block-prompt.ts";
import { callLabel, canonicalJson, shortReason } from "./call-label.ts";

const plain = { fg: (_slot: string, text: string) => text, bold: (text: string) => text };

function clock(start = 0) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("the ask before a block", () => {
	it("answers with the highlighted choice, a hotkey, or Esc as a refusal", () => {
		const c = clock();
		const p = new BlockPrompt(30_000, c.now);
		p.confirm();
		expect(p.result).toBe("allow");
		const q = new BlockPrompt(30_000, c.now);
		q.move(1);
		q.confirm();
		expect(q.result).toBe("deny");
		const r = new BlockPrompt(30_000, c.now);
		r.press("Y");
		expect(r.result).toBe("allow");
		const s = new BlockPrompt(30_000, c.now);
		s.cancel();
		expect(s.result).toBe("deny");
	});

	it("distinguishes session approval from one-shot approval", () => {
		const scoped = new BlockPrompt(30_000, Date.now, true);
		scoped.press("y");
		expect(scoped.result).toBe("allow-session");
		const once = new BlockPrompt(30_000, Date.now, true);
		once.press("Y");
		expect(once.result).toBe("allow");
		const unavailable = new BlockPrompt(30_000);
		unavailable.press("y");
		expect(unavailable.result).toBeUndefined();
	});

	it("offers four clear lifetime choices with the session choice as default", () => {
		const prompt = new BlockPrompt(30_000, Date.now, true, false, true);
		expect(prompt.choices.map(choice => choice.label)).toEqual([
			"Allow for this session", "Allow for this and future sessions", "Allow once", "Deny",
		]);
		prompt.confirm();
		expect(prompt.result).toBe("allow-session");
		const future = new BlockPrompt(30_000, Date.now, true, false, true);
		future.press("f");
		expect(future.result).toBe("allow-future");
		const unavailable = new BlockPrompt(30_000, Date.now, true);
		unavailable.press("f");
		expect(unavailable.result).toBeUndefined();
	});

	it("keeps the block when the time runs out, and not before", () => {
		const c = clock();
		const p = new BlockPrompt(30_000, c.now);
		c.advance(29_999);
		p.tick();
		expect(p.result).toBeUndefined();
		expect(p.secondsLeft()).toBe(1);
		c.advance(1);
		p.tick();
		expect(p.result).toBe("timeout");
		// An answer after the fact does not replace it.
		p.press("y");
		expect(p.result).toBe("timeout");
	});

	for (const [name, key, cursor] of [["down", "\x1b[B", 1], ["up", "\x1b[A", 1], ["tab", "\t", 0], ["unbound key", "x", 0], ["paste", "\x1b[200~Y\x1b[201~", 0]] as const) {
		it(`removes and stops the countdown on ${name}, without answering`, () => {
			const c = clock();
			const p = new BlockPrompt(30_000, c.now);
			const view = new BlockPromptView(p, { toolName: "bash", input: {}, reason: "Review this", timeoutSeconds: 30 }, plain);
			expect(view.render(80).join("\n")).toContain("No answer in 30s");
			view.handleInput(key);
			expect(view.render(80).join("\n")).not.toContain("No answer in");
			expect(view.render(80).join("\n")).not.toContain("Timer stopped");
			expect(p.cursor).toBe(cursor);
			c.advance(60_000);
			p.tick();
			expect(p.result).toBeUndefined();
			view.handleInput("\r");
			expect(p.result).toBe(cursor === 1 ? "deny" : "allow");
		});
	}

	it("does not mistake terminal focus reports for keyboard interaction", () => {
		const c = clock();
		const p = new BlockPrompt(30_000, c.now);
		const view = new BlockPromptView(p, { toolName: "bash", input: {}, reason: "Review this", timeoutSeconds: 30 }, plain);
		view.handleInput("\x1b[I");
		c.advance(30_000);
		p.tick();
		expect(p.result).toBe("timeout");
	});

	it("pauses the deadline when the user requests an explanation", () => {
		const c = clock();
		const p = new BlockPrompt(30_000, c.now);
		c.advance(5_000);
		p.press("e");
		c.advance(60_000);
		p.tick();
		expect(p.result).toBeUndefined();
		expect(p.secondsLeft()).toBe(25);
		p.press("n");
		expect(p.result).toBe("deny");
	});

	it("shows command details without executing or approving, and stays paused on return", () => {
		const c = clock();
		const p = new BlockPrompt(30_000, c.now);
		const view = new BlockPromptView(p, { toolName: "bash", input: { command: "ssh torrent make check", timeout: 60 }, reason: "Remote execution needs approval.", timeoutSeconds: 30 }, plain);
		view.handleInput("e");
		const detail = view.render(80).join("\n");
		expect(detail).toContain("Exact command (not executed)");
		expect(detail).toContain("ssh torrent make check");
		expect(detail).toContain("Remote execution needs approval.");
		c.advance(60_000);
		p.tick();
		view.handleInput("e");
		expect(p.result).toBeUndefined();
		expect(view.render(80).join("\n")).not.toContain("No answer in");
		view.handleInput("Y");
		expect(p.result).toBe("allow");
	});

	it("scrolls long explanations and escape returns without denying", () => {
		const p = new BlockPrompt(30_000);
		const view = new BlockPromptView(p, { toolName: "bash", input: { command: "echo x\n".repeat(50) }, reason: "Review command", timeoutSeconds: 30 }, plain, () => 12);
		view.handleInput("e");
		const first = view.render(60);
		view.handleInput("j");
		expect(view.render(60)).not.toEqual(first);
		view.handleInput("\x1b");
		expect(p.result).toBeUndefined();
		expect(view.render(60).join("\n")).not.toContain("No answer in");
	});

	it("names the call, gives the reason, and counts down", () => {
		const c = clock();
		const p = new BlockPrompt(30_000, c.now);
		const view = new BlockPromptView(p, { toolName: "bash", input: { command: "rm -rf build" }, reason: "Deletes files.", timeoutSeconds: 30 }, plain);
		const lines = view.render(60);
		expect(lines[0]).toBe("● Bash(rm -rf build)");
		expect(lines[1]).toBe("  ⎿  Deletes files.");
		expect(lines).toContain("❯ Allow once (Y)");
		expect(lines).toContain("  Deny (n)");
		expect(lines).toContain("No answer in 30s keeps the block");
		c.advance(4_000);
		expect(view.render(60)).toContain("No answer in 26s keeps the block");
	});
});

describe("call labels", () => {
	it("name a call by the argument that says what it acts on", () => {
		expect(callLabel("bash", { command: "ls\n-la", timeout: 5 })).toEqual({ title: "Bash", target: "ls ⏎ -la" });
		expect(callLabel("write", { path: "/etc/hosts", content: "x" })).toEqual({ title: "Write", target: "/etc/hosts" });
		expect(callLabel("todo", {})).toEqual({ title: "Todo", target: "" });
	});

	it("compare inputs whatever their key order", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
	});
});

describe("short reasons", () => {
	it("keep what decided and drop the wrapping meant for the model", () => {
		expect(
			shortReason(
				"[pi-permission-system] The 'pi-automode' authorizer denied this 'bash' call. Reason: [pi-automode] Action blocked; the tool did not run. Contains zebra. The user was asked and did not answer within 8s; if they later tell you to go ahead, retry it. Do not claim success, rely on effects.",
			),
		).toBe("Contains zebra. The user was asked and did not answer within 8s; if they later tell you to go ahead, retry it.");
		expect(shortReason("[pi-automode] Action blocked; the tool did not run. Path denied by policy: /x Do not claim success.")).toBe(
			"Path denied by policy: /x",
		);
		expect(shortReason("[pi-permission-system] Denied by policy: 'bash' call.")).toBe("Denied by policy: 'bash' call.");
	});
});

it("linked reviews offer only rechecked scope approval, never an execution bypass", () => {
	const prompt = new BlockPrompt(1000, () => 0, true, true);
	expect(prompt.choices.map(c => c.answer)).toEqual(["allow-session", "deny"]);
	prompt.press("Y");
	expect(prompt.result).toBeUndefined();
	prompt.press("y");
	expect(prompt.result).toBe("allow-session");
});

describe("native permission program status", () => {
	it("marks approval waits as permission blockers and clears even when the dialog fails", async () => {
		const { askBeforeBlock } = await import("./block-prompt.ts");
		const statuses: any[] = [];
		const ctx = { ui: { setProgramStatus: (key: string, status: unknown) => statuses.push({ key, status }), custom: async () => {
			expect(statuses.at(-1)?.status).toMatchObject({ state: "blocked", kind: "permission" });
			throw new Error("UI failed");
		} } };
		await expect(askBeforeBlock(ctx as never, { toolName: "bash", input: { command: "PRIVATE_COMMAND" }, reason: "PRIVATE_REASON", timeoutSeconds: 30 })).rejects.toThrow("UI failed");
		expect(statuses.at(-1)?.status).toBeUndefined();
		expect(JSON.stringify(statuses)).not.toContain("PRIVATE_");
		expect(statuses.length).toBe(2);
	});
});

it("engine policy prompts also publish permission status and clear it on failure", async () => {
	const { presentInlinePermissionPrompt } = await import("../engine/authority/permission-prompt-component.ts");
	const reports: any[] = [];
	const ui = { setProgramStatus: (_key: string, status: unknown) => reports.push(status), custom: async () => {
		expect(reports.at(-1)).toMatchObject({ state: "blocked", kind: "permission" });
		throw new Error("dialog failed");
	} };
	await expect(presentInlinePermissionPrompt({ ui } as never, "Private approval", {} as never)).rejects.toThrow("dialog failed");
	expect(reports.at(-1)).toBeUndefined(); expect(reports).toHaveLength(2);
});

for (const finish of ["enter", "abort", "timeout"] as const) {
	it(`settles the live timed prompt correctly after ${finish}`, async () => {
		const { askBeforeBlock } = await import("./block-prompt.ts");
		const controller = new AbortController();
		const reports: any[] = [];
		let component: any;
		let tick = () => {};
		const timer = {};
		const now = spyOn(Date, "now").mockReturnValue(0);
		const interval = spyOn(globalThis, "setInterval").mockImplementation((callback: any) => { tick = callback; return timer as never; });
		const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
		const ctx = { signal: controller.signal, ui: {
			setProgramStatus: (_key: string, status: unknown) => reports.push(status),
			custom: (factory: Function) => new Promise(resolve => {
				component = factory({ requestRender() {} }, plain, {}, resolve);
			}),
		} };
		let settled = false;
		const answer = askBeforeBlock(ctx as never, { toolName: "bash", input: {}, reason: "Review this", timeoutSeconds: 30 });
		void answer.then(() => { settled = true; });
		try {
			if (finish !== "timeout") {
				component.handleInput("\x1b[B");
				expect(clear).toHaveBeenCalledWith(timer);
				expect(component.render(80).join("\n")).not.toContain("No answer in");
			}
			now.mockReturnValue(60_000);
			tick(); // Even a tick already dispatched before clearInterval cannot time out an active review.
			if (finish !== "timeout") {
				await Promise.resolve();
				expect(settled).toBe(false);
				expect(reports.at(-1)?.state).toBe("blocked");
				if (finish === "enter") component.handleInput("\r");
				else controller.abort();
			}
			expect(await answer).toBe(finish === "timeout" ? "timeout" : "deny");
			expect(reports.at(-1)).toBeUndefined();
		} finally {
			controller.abort();
			component?.dispose();
			await answer.catch(() => {});
			clear.mockRestore();
			interval.mockRestore();
			now.mockRestore();
		}
	});
}
