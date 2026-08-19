// Differential test against pi's own source. pi-notify subscribes to three
// event names and calls pi.exec with a fixed arity; nothing else here would
// notice a rename, because a handler registered for an event pi never fires is
// silent by construction — the same failure shape as F8.
//
// PI_CODING_AGENT_SRC points at the unpacked pi source; the Nix check sets it.
// The file skips without it, so `bun test` still works in a plain checkout.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = process.env.PI_CODING_AGENT_SRC;
const types = () => readFileSync(`${SRC}/packages/coding-agent/src/core/extensions/types.ts`, "utf8");

const describeAgainstPi = SRC === undefined ? describe.skip : describe;

describeAgainstPi("the events pi-notify subscribes to", () => {
	it("are all declared on ExtensionAPI.on", () => {
		const source = types();
		for (const event of ["agent_settled", "tool_execution_start", "tool_execution_end"]) {
			expect(source).toContain(`on(event: "${event}", handler:`);
		}
	});

	it("carry toolCallId and toolName on both execution events, which the clock keys on", () => {
		const source = types();
		for (const name of ["ToolExecutionStartEvent", "ToolExecutionEndEvent"]) {
			const start = source.indexOf(`export interface ${name} {`);
			expect(start).toBeGreaterThan(-1);
			const body = source.slice(start, source.indexOf("\n}", start));
			expect(body).toContain("toolCallId: string;");
			expect(body).toContain("toolName: string;");
		}
	});

	it("give agent_settled no payload, so the handler must not read one", () => {
		const source = types();
		const start = source.indexOf("export interface AgentSettledEvent {");
		expect(start).toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf("\n}", start));
		expect(body).toContain('type: "agent_settled";');
		expect(body.split("\n").filter((l) => /^\t[a-zA-Z]/.test(l))).toHaveLength(1);
	});
});

describeAgainstPi("the surfaces pi-notify calls", () => {
	it("exec takes a command and an argv array, so a body can never become a flag", () => {
		expect(types()).toContain("exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;");
	});

	it("the event bus is on the extension API and has on()", () => {
		expect(types()).toMatch(/^\tevents: EventBus;/m);
		const bus = readFileSync(`${SRC}/packages/coding-agent/src/core/event-bus.ts`, "utf8");
		expect(bus).toMatch(/on\(/);
		expect(bus).toMatch(/emit\(/);
	});
});
