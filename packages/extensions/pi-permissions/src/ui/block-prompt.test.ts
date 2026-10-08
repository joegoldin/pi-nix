import { describe, expect, it } from "bun:test";
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

	it("names the call, gives the reason, and counts down", () => {
		const c = clock();
		const p = new BlockPrompt(30_000, c.now);
		const view = new BlockPromptView(p, { toolName: "bash", input: { command: "rm -rf build" }, reason: "Deletes files.", timeoutSeconds: 30 }, plain);
		const lines = view.render(60);
		expect(lines[0]).toBe("● Bash(rm -rf build)");
		expect(lines[1]).toBe("  ⎿  Deletes files.");
		expect(lines).toContain("❯ Allow (y)");
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
