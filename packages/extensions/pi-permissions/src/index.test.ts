import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import piPermissions from "./index.ts";

/** A session's event bus as pi builds it, and a pi that records what is registered. */
function session() {
	const emitter = new EventEmitter();
	const bus = {
		emit: (channel: string, data: unknown) => emitter.emit(channel, data),
		on: (channel: string, handler: (data: unknown) => unknown) => {
			const safe = async (data: unknown) => {
				await handler(data);
			};
			emitter.on(channel, safe);
			return () => emitter.off(channel, safe);
		},
	};
	const tools: string[] = [];
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
	const entries: { type: string; customType: string; data: unknown }[] = [];
	const api = () =>
		({
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			events: { emit: bus.emit, on: bus.on },
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, command),
			sendMessage: (message: { customType: string; content: string }, options: unknown) => sent.push({ message, options }),
			registerShortcut() {},
			registerFlag() {},
			registerMessageRenderer() {},
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools() {},
		}) as never;
	/** Run a tool call through every handler, stopping at the first block, as pi does. */
	const toolCall = async (event: unknown, ctx: unknown) => {
		for (const handler of handlers.get("tool_call") ?? []) {
			const result = (await handler(event, ctx)) as { block?: boolean; reason?: string } | undefined;
			if (result?.block) return result;
		}
		return undefined;
	};
	return { api, tools, handlers, commands, sent, entries, toolCall };
}

describe("loading", () => {
	it("registers once per session however many times it is loaded", () => {
		const s = session();
		piPermissions(s.api());
		const once = [...s.tools];
		piPermissions(s.api());
		expect(once.length).toBeGreaterThan(0);
		expect(s.tools).toEqual(once);
	});

	it("registers in each session", () => {
		const a = session();
		const b = session();
		piPermissions(a.api());
		piPermissions(b.api());
		expect(b.tools).toEqual(a.tools);
	});
});

describe("the ledger around both halves", () => {
	it("records a block, and an approved call passes both halves after it", async () => {
		const s = session();
		piPermissions(s.api());
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			mode: "print",
			isIdle: () => true,
			ui: { notify() {}, setStatus() {} },
			sessionManager: { getEntries: () => s.entries, getSessionId: () => "s1", getSessionFile: () => undefined, getSessionDir: () => "/tmp", getBranch: () => [] },
			isProjectTrusted: () => false,
		};
		// A shell profile write: auto mode's deterministic hard deny, no model call.
		const call = { toolName: "write", toolCallId: "c1", input: { path: join(homedir(), ".bashrc"), content: "alias x=y" } };
		const blocked = await s.toolCall(call, ctx);
		expect(blocked?.block).toBe(true);
		// Headless: the agent is not told of a menu it cannot reach.
		expect(blocked?.reason).not.toContain("/permissions");
		const record = s.entries.at(-1)!.data as { denials: { toolCallId: string; state: string }[] };
		expect(record.denials).toEqual([expect.objectContaining({ toolCallId: "c1", state: "open" })]);

		await s.commands.get("permissions")!.handler("approve last", ctx);
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]!.message.content).toContain("Write(");
		expect(s.sent[0]!.options).toEqual({ triggerTurn: true });

		expect(await s.toolCall({ ...call, toolCallId: "c2" }, ctx)).toBeUndefined();
		// A different input is not covered.
		expect((await s.toolCall({ ...call, toolCallId: "c3", input: { ...call.input, content: "other" } }, ctx))?.block).toBe(true);
	});
});
