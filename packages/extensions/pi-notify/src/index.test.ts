import { describe, expect, it, mock } from "bun:test";
import { DEFAULT_CONFIG } from "./config.ts";
import { AUTO_MODE_PROMPT_CHANNEL, PERMISSIONS_UI_PROMPT_CHANNEL, registerHandlers } from "./index.ts";

function host() {
	const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
	const channels = new Map<string, (data: unknown) => void>();
	return {
		on: (event: string, handler: never) => handlers.set(event, handler as never),
		events: {
			on: (channel: string, handler: never) => {
				channels.set(channel, handler as never);
				return () => channels.delete(channel);
			},
		},
		exec: mock(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
		fire: (event: string, payload: unknown) => handlers.get(event)?.(payload),
		emit: (channel: string, payload: unknown) => channels.get(channel)?.(payload),
		handlers,
		channels,
	};
}

const config = {
	...DEFAULT_CONFIG,
	enabled: true,
	notifier: "/bin/notify-send",
	longToolCallThresholdMs: 5000,
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("registerHandlers", () => {
	it("registers nothing when disabled", () => {
		const h = host();
		registerHandlers(h as never, { ...config, enabled: false }, () => 0);
		expect(h.handlers.size).toBe(0);
		expect(h.channels.size).toBe(0);
	});

	it("registers nothing when the notifier path is empty", () => {
		const h = host();
		registerHandlers(h as never, { ...config, notifier: "" }, () => 0);
		expect(h.handlers.size).toBe(0);
	});

	it("notifies on agent_settled", async () => {
		const h = host();
		registerHandlers(h as never, config, () => 0);
		await h.fire("agent_settled", { type: "agent_settled" });
		expect(h.exec).toHaveBeenCalledTimes(1);
		const [command, args] = h.exec.mock.calls[0]! as [string, string[]];
		expect(command).toBe("/bin/notify-send");
		expect(args).toContain("pi");
	});

	it("notifies on a pi-auto-mode prompt event with critical urgency", async () => {
		const h = host();
		registerHandlers(h as never, config, () => 0);
		h.emit(AUTO_MODE_PROMPT_CHANNEL, { toolName: "bash", toolCallId: "c1", value: "rm -rf /", detail: "429" });
		await settle();
		expect(h.exec).toHaveBeenCalledTimes(1);
		expect(h.exec.mock.calls[0]![1]).toContain("critical");
		expect((h.exec.mock.calls[0]![1] as string[]).join(" ")).toContain("bash");
	});

	it("notifies on a pi-permission-system UI prompt event", async () => {
		const h = host();
		registerHandlers(h as never, config, () => 0);
		h.emit(PERMISSIONS_UI_PROMPT_CHANNEL, { requestId: "r1", toolName: "bash" });
		await settle();
		expect(h.exec).toHaveBeenCalledTimes(1);
	});

	it("stays silent for a tool call under the threshold", async () => {
		const h = host();
		let clock = 0;
		registerHandlers(h as never, config, () => clock);
		await h.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
		clock = 1000;
		await h.fire("tool_execution_end", { toolCallId: "c1", toolName: "bash" });
		expect(h.exec).not.toHaveBeenCalled();
	});

	it("notifies for a tool call over the threshold, naming the tool", async () => {
		const h = host();
		let clock = 0;
		registerHandlers(h as never, config, () => clock);
		await h.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
		clock = 61000;
		await h.fire("tool_execution_end", { toolCallId: "c1", toolName: "bash" });
		expect((h.exec.mock.calls[0]![1] as string[]).join(" ")).toContain("bash");
	});

	it("stays silent for a tool end it never saw start", async () => {
		const h = host();
		registerHandlers(h as never, config, () => 999999);
		await h.fire("tool_execution_end", { toolCallId: "unknown", toolName: "bash" });
		expect(h.exec).not.toHaveBeenCalled();
	});

	it("honours per-event toggles", () => {
		const h = host();
		registerHandlers(
			h as never,
			{ ...config, events: { permissionPrompt: false, agentSettled: false, longToolCall: true } },
			() => 0,
		);
		expect(h.handlers.has("agent_settled")).toBe(false);
		expect(h.channels.has(AUTO_MODE_PROMPT_CHANNEL)).toBe(false);
		expect(h.handlers.has("tool_execution_start")).toBe(true);
	});

	it("swallows a failing notifier so a broken notify-send never breaks the session", async () => {
		const h = host();
		h.exec = mock(async () => {
			throw new Error("no dbus");
		});
		registerHandlers(h as never, config, () => 0);
		expect(h.fire("agent_settled", {})).resolves.toBeUndefined();
	});
});

describe("the channel names pi-notify listens on", () => {
	it("matches pi-auto-mode's exported literal", () => {
		expect(AUTO_MODE_PROMPT_CHANNEL).toBe("pi-auto-mode:prompt");
	});

	it("matches pi-permission-system's PERMISSIONS_UI_PROMPT_CHANNEL", () => {
		expect(PERMISSIONS_UI_PROMPT_CHANNEL).toBe("permissions:ui_prompt");
	});
});
