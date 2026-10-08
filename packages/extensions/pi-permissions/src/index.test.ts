import { describe, expect, it } from "bun:test";
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
	const api = () =>
		({
			on() {},
			events: { emit: bus.emit, on: bus.on },
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerCommand() {},
			registerShortcut() {},
			registerFlag() {},
			registerMessageRenderer() {},
			appendEntry() {},
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools() {},
		}) as never;
	return { api, tools };
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
