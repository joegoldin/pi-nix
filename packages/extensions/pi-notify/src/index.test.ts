import { describe, expect, it, mock } from "bun:test";
import { DEFAULT_CONFIG } from "./config.ts";
import {
	PERMISSIONS_DECISION_CHANNEL,
	PERMISSIONS_UI_PROMPT_CHANNEL,
	registerHandlers,
} from "./index.ts";

const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });

function host(exec: (command: string, args: string[]) => Promise<unknown> = async () => ok()) {
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
		exec: mock(exec),
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

	it("raises a permission prompt at critical urgency", async () => {
		const h = host();
		registerHandlers(h as never, config, () => 0);
		h.emit(PERMISSIONS_UI_PROMPT_CHANNEL, { requestId: "r1", surface: "bash", value: "rm -rf /" });
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

	// PermissionUiPromptEvent has no toolName. The display name lives in
	// `surface` (the permission system's permission-events.ts), so reading
	// toolName made every one of these notifications say "a tool call".
	it("names the surface from a pi-permission-system prompt", async () => {
		const h = host();
		registerHandlers(h as never, config, () => 0);
		h.emit(PERMISSIONS_UI_PROMPT_CHANNEL, { requestId: "r1", surface: "bash", value: "git push" });
		await settle();
		expect((h.exec.mock.calls[0]![1] as string[]).join(" ")).toContain("bash");
	});

	it("falls back to a generic phrase when the prompt names nothing", async () => {
		const h = host();
		registerHandlers(h as never, config, () => 0);
		h.emit(PERMISSIONS_UI_PROMPT_CHANNEL, { requestId: "r1" });
		await settle();
		expect((h.exec.mock.calls[0]![1] as string[]).join(" ")).toContain("a tool call");
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
		expect(h.channels.has(PERMISSIONS_UI_PROMPT_CHANNEL)).toBe(false);
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

describe("dismissing a permission notification once the ask is answered", () => {
	const dismissing = { ...config, dismisser: "/bin/gdbus" };

	const raise = async (h: ReturnType<typeof host>, requestId = "r1") => {
		h.emit(PERMISSIONS_UI_PROMPT_CHANNEL, { requestId, surface: "bash", toolName: "bash" });
		await settle();
	};
	const resolve = async (h: ReturnType<typeof host>, requestId = "r1") => {
		h.emit(PERMISSIONS_DECISION_CHANNEL, { requestId, surface: "bash", value: "ls", result: "allow" });
		await settle();
	};

	it("asks notify-send to print its id, without which there is nothing to close", async () => {
		const h = host();
		registerHandlers(h as never, dismissing, () => 0);
		await raise(h);
		expect(h.exec.mock.calls[0]![1]).toContain("--print-id");
	});

	it("closes the notification with the id notify-send printed", async () => {
		const h = host(async () => ok("42\n"));
		registerHandlers(h as never, dismissing, () => 0);
		await raise(h);
		await resolve(h);
		expect(h.exec).toHaveBeenCalledTimes(2);
		const [command, args] = h.exec.mock.calls[1]! as [string, string[]];
		expect(command).toBe("/bin/gdbus");
		expect(args).toContain("org.freedesktop.Notifications.CloseNotification");
		expect(args[args.length - 1]).toBe("42");
	});

	it("stays put when no id came back, because there is no handle to close", async () => {
		const h = host(async () => ok(""));
		registerHandlers(h as never, dismissing, () => 0);
		await raise(h);
		await resolve(h);
		expect(h.exec).toHaveBeenCalledTimes(1);
	});

	it("ignores a decision for a request it never notified about", async () => {
		const h = host(async () => ok("42\n"));
		registerHandlers(h as never, dismissing, () => 0);
		await raise(h, "r1");
		await resolve(h, "r2");
		expect(h.exec).toHaveBeenCalledTimes(1);
	});

	it("closes an ask once, so a second decision on the same request is a no-op", async () => {
		const h = host(async () => ok("42\n"));
		registerHandlers(h as never, dismissing, () => 0);
		await raise(h);
		await resolve(h);
		await resolve(h);
		expect(h.exec).toHaveBeenCalledTimes(2);
	});

	it("does nothing when dismissal is switched off", async () => {
		const h = host(async () => ok("42\n"));
		registerHandlers(h as never, { ...dismissing, dismissOnResolve: false }, () => 0);
		await raise(h);
		await resolve(h);
		expect(h.exec).toHaveBeenCalledTimes(1);
		expect(h.exec.mock.calls[0]![1]).not.toContain("--print-id");
	});

	it("degrades silently under osascript, which has no close API", async () => {
		const h = host(async () => ok("42\n"));
		registerHandlers(h as never, { ...dismissing, style: "osascript" }, () => 0);
		await raise(h);
		await resolve(h);
		expect(h.exec).toHaveBeenCalledTimes(1);
	});

	it("degrades silently when no D-Bus client was baked into the config", async () => {
		const h = host(async () => ok("42\n"));
		registerHandlers(h as never, { ...dismissing, dismisser: "" }, () => 0);
		await raise(h);
		await resolve(h);
		expect(h.exec).toHaveBeenCalledTimes(1);
	});

	it("removes the terminal-notifier group rather than a D-Bus id", async () => {
		const h = host(async () => ok(""));
		registerHandlers(h as never, { ...dismissing, style: "terminal-notifier" }, () => 0);
		await raise(h);
		await resolve(h);
		expect(h.exec).toHaveBeenCalledTimes(2);
		const [command, args] = h.exec.mock.calls[1]! as [string, string[]];
		expect(command).toBe("/bin/notify-send");
		expect(args).toEqual(["-remove", "pi-ask"]);
	});

	it("swallows a failing dismissal, exactly as it swallows a failing send", async () => {
		let calls = 0;
		const h = host(async () => {
			calls += 1;
			if (calls > 1) throw new Error("no dbus");
			return ok("42\n");
		});
		registerHandlers(h as never, dismissing, () => 0);
		await raise(h);
		await resolve(h);
		expect(calls).toBe(2);
	});

	it("registers no decision listener when permission prompts are off", () => {
		const h = host();
		registerHandlers(
			h as never,
			{ ...dismissing, events: { permissionPrompt: false, agentSettled: true, longToolCall: true } },
			() => 0,
		);
		expect(h.channels.has(PERMISSIONS_DECISION_CHANNEL)).toBe(false);
	});
});

describe("the channel names pi-notify listens on", () => {
	it("matches pi-permission-system's PERMISSIONS_UI_PROMPT_CHANNEL", () => {
		expect(PERMISSIONS_UI_PROMPT_CHANNEL).toBe("permissions:ui_prompt");
	});

	it("matches pi-permission-system's PERMISSIONS_DECISION_CHANNEL", () => {
		expect(PERMISSIONS_DECISION_CHANNEL).toBe("permissions:decision");
	});
});
