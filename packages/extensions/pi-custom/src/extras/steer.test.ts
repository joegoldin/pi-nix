import { expect, it } from "bun:test";
import { registerSteeringGuard, STEERING } from "./steer.ts";

function harness() {
	const events = new Map<string, Function>();
	let input: ((data: string) => unknown) | undefined;
	const state = { idle: false, pending: true };
	const ctx = {
		hasUI: true, isIdle: () => state.idle, hasPendingMessages: () => state.pending,
		ui: { onTerminalInput: (handler: typeof input) => { input = handler; return () => { input = undefined; }; } },
	};
	// No widget, editor access, shortcuts or message sending: those belong to Pi.
	registerSteeringGuard({ on: (event: string, handler: Function) => events.set(event, handler) } as never);
	const emit = (event: string) => events.get(event)?.({}, ctx);
	emit("session_start");
	return { state, emit, input: (data: string) => input?.(data) };
}

it("preserves the goal for Escape restoring a queue, without consuming the key", () => {
	const h = harness();
	expect(h.input("\x1b")).toBeUndefined();
	expect((globalThis as any)[STEERING]).toBe(true);
	h.emit("agent_settled");
	expect((globalThis as any)[STEERING]).toBe(false);
});

it("does not treat bare Escape or idle input as steering", () => {
	const h = harness();
	h.state.pending = false;
	h.input("\x1b[27u");
	expect((globalThis as any)[STEERING]).toBe(false);
	h.state.pending = true;
	h.state.idle = true;
	h.input("\x1b");
	expect((globalThis as any)[STEERING]).toBe(false);
});

it("cleans up the input listener and marker on shutdown", () => {
	const h = harness();
	h.input("\x1b");
	h.emit("session_shutdown");
	h.input("\x1b");
	expect((globalThis as any)[STEERING]).toBe(false);
});
