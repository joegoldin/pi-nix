import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import {
	createToolClock,
	dismissCommand,
	escapeAppleScript,
	longToolNotification,
	notificationHandle,
	notifierArgs,
} from "./notifier.ts";

const note = { title: "pi", body: "done", urgency: "normal" as const };

describe("loadConfig", () => {
	it("is disabled when the env var is unset", () => {
		expect(loadConfig(() => "", {}).enabled).toBe(false);
	});

	it("merges a well-formed file over the defaults", () => {
		const cfg = loadConfig(
			() =>
				JSON.stringify({
					enabled: true,
					notifier: "/nix/store/x/bin/notify-send",
					longToolCallThresholdMs: 5000,
				}),
			{ PI_NOTIFY_CONFIG: "/c.json" },
		);
		expect(cfg.enabled).toBe(true);
		expect(cfg.notifier).toBe("/nix/store/x/bin/notify-send");
		expect(cfg.longToolCallThresholdMs).toBe(5000);
		expect(cfg.events).toEqual(DEFAULT_CONFIG.events);
	});

	it("disables itself on malformed JSON, because a broken notifier must not spam", () => {
		expect(loadConfig(() => "{nope", { PI_NOTIFY_CONFIG: "/c.json" }).enabled).toBe(false);
	});

	it("disables itself when the file cannot be read at all", () => {
		expect(
			loadConfig(
				() => {
					throw new Error("ENOENT");
				},
				{ PI_NOTIFY_CONFIG: "/gone.json" },
			).enabled,
		).toBe(false);
	});

	it("dismisses resolved asks by default, so a stale prompt does not linger", () => {
		expect(loadConfig(() => JSON.stringify({ enabled: true }), { PI_NOTIFY_CONFIG: "/c.json" }).dismissOnResolve).toBe(
			true,
		);
	});

	it("honours dismissOnResolve: false", () => {
		expect(
			loadConfig(() => JSON.stringify({ enabled: true, dismissOnResolve: false }), { PI_NOTIFY_CONFIG: "/c.json" })
				.dismissOnResolve,
		).toBe(false);
	});

	it("takes the D-Bus client path from the file, since nothing here searches PATH", () => {
		expect(
			loadConfig(() => JSON.stringify({ enabled: true, dismisser: "/nix/store/x/bin/gdbus" }), {
				PI_NOTIFY_CONFIG: "/c.json",
			}).dismisser,
		).toBe("/nix/store/x/bin/gdbus");
	});

	it("ignores a non-string dismisser rather than handing it to exec", () => {
		expect(
			loadConfig(() => JSON.stringify({ enabled: true, dismisser: 7 }), { PI_NOTIFY_CONFIG: "/c.json" }).dismisser,
		).toBe("");
	});

	it("rejects an unknown style rather than passing it to argv construction", () => {
		expect(
			loadConfig(() => JSON.stringify({ enabled: true, style: "toast" }), { PI_NOTIFY_CONFIG: "/c.json" }).style,
		).toBe(DEFAULT_CONFIG.style);
	});
});

describe("escapeAppleScript", () => {
	it("escapes backslashes before quotes", () => {
		expect(escapeAppleScript('a\\b"c')).toBe('a\\\\b\\"c');
	});

	it("strips newlines, which terminate an osascript -e statement", () => {
		expect(escapeAppleScript("a\nb")).toBe("a b");
	});
});

describe("notifierArgs", () => {
	const base = { ...DEFAULT_CONFIG, enabled: true, appName: "pi" };

	it("builds notify-send argv with the app name and urgency", () => {
		expect(notifierArgs({ ...base, style: "notify-send" }, note)).toEqual([
			"--app-name",
			"pi",
			"--urgency",
			"normal",
			"pi",
			"done",
		]);
	});

	it("builds terminal-notifier argv", () => {
		expect(notifierArgs({ ...base, style: "terminal-notifier" }, note)).toEqual([
			"-title",
			"pi",
			"-message",
			"done",
			"-group",
			"pi",
		]);
	});

	it("builds a single escaped osascript statement", () => {
		expect(notifierArgs({ ...base, style: "osascript" }, { ...note, body: 'say "hi"' })).toEqual([
			"-e",
			'display notification "say \\"hi\\"" with title "pi"',
		]);
	});

	it("maps critical urgency onto notify-send's critical level", () => {
		expect(notifierArgs({ ...base, style: "notify-send" }, { ...note, urgency: "critical" })).toContain("critical");
	});

	it("never lets a title or body become another flag, because both are argv-separated", () => {
		const args = notifierArgs({ ...base, style: "notify-send" }, { ...note, body: "--urgency critical" });
		expect(args[args.length - 1]).toBe("--urgency critical");
		expect(args.filter((a) => a === "--urgency")).toHaveLength(1);
	});
});

describe("notifierArgs for a dismissible notification", () => {
	const base = { ...DEFAULT_CONFIG, enabled: true, appName: "pi" };

	it("adds --print-id so notify-send hands back a closable id", () => {
		expect(notifierArgs({ ...base, style: "notify-send" }, note, true)).toEqual([
			"--app-name",
			"pi",
			"--urgency",
			"normal",
			"--print-id",
			"pi",
			"done",
		]);
	});

	it("gives terminal-notifier its own group, so -remove spares unrelated pi notifications", () => {
		expect(notifierArgs({ ...base, style: "terminal-notifier" }, note, true)).toEqual([
			"-title",
			"pi",
			"-message",
			"done",
			"-group",
			"pi-ask",
		]);
	});

	it("leaves osascript argv alone, because there is nothing it could print", () => {
		expect(notifierArgs({ ...base, style: "osascript" }, note, true)).toEqual(
			notifierArgs({ ...base, style: "osascript" }, note),
		);
	});
});

describe("notificationHandle", () => {
	const base = { ...DEFAULT_CONFIG, enabled: true, appName: "pi" };

	it("reads notify-send's id off stdout", () => {
		expect(notificationHandle({ ...base, style: "notify-send" }, "42\n")).toEqual({ style: "notify-send", id: "42" });
	});

	it("is null when stdout held no id, so nothing is tracked that cannot be closed", () => {
		expect(notificationHandle({ ...base, style: "notify-send" }, "")).toBeNull();
		expect(notificationHandle({ ...base, style: "notify-send" }, "gtk warning")).toBeNull();
	});

	it("uses the group for terminal-notifier, which prints no id", () => {
		expect(notificationHandle({ ...base, style: "terminal-notifier" }, "")).toEqual({
			style: "terminal-notifier",
			group: "pi-ask",
		});
	});

	it("is null for osascript, which cannot be closed at all", () => {
		expect(notificationHandle({ ...base, style: "osascript" }, "42")).toBeNull();
	});
});

describe("dismissCommand", () => {
	const base = { ...DEFAULT_CONFIG, enabled: true, appName: "pi", notifier: "/bin/notify-send" };

	it("calls CloseNotification through the configured D-Bus client", () => {
		expect(dismissCommand({ ...base, dismisser: "/bin/gdbus" }, { style: "notify-send", id: "42" })).toEqual({
			command: "/bin/gdbus",
			args: [
				"call",
				"--session",
				"--dest",
				"org.freedesktop.Notifications",
				"--object-path",
				"/org/freedesktop/Notifications",
				"--method",
				"org.freedesktop.Notifications.CloseNotification",
				"42",
			],
		});
	});

	it("is null without a D-Bus client, since CloseNotification has no CLI of its own", () => {
		expect(dismissCommand({ ...base, dismisser: "" }, { style: "notify-send", id: "42" })).toBeNull();
	});

	it("removes the group through terminal-notifier itself", () => {
		expect(dismissCommand(base, { style: "terminal-notifier", group: "pi-ask" })).toEqual({
			command: "/bin/notify-send",
			args: ["-remove", "pi-ask"],
		});
	});
});

describe("createToolClock", () => {
	it("reports the elapsed time and the tool name on end", () => {
		const clock = createToolClock();
		clock.start("c1", "bash", 1000);
		expect(clock.end("c1", 4500)).toEqual({ toolName: "bash", elapsedMs: 3500 });
	});

	it("returns null for an end with no matching start", () => {
		expect(createToolClock().end("nope", 1)).toBeNull();
	});

	it("forgets a call after ending it, so a duplicate end is null", () => {
		const clock = createToolClock();
		clock.start("c1", "bash", 0);
		clock.end("c1", 10);
		expect(clock.end("c1", 20)).toBeNull();
	});

	it("tracks concurrent calls independently", () => {
		const clock = createToolClock();
		clock.start("a", "bash", 0);
		clock.start("b", "read", 100);
		expect(clock.end("b", 200)?.elapsedMs).toBe(100);
		expect(clock.end("a", 500)?.elapsedMs).toBe(500);
	});
});

describe("longToolNotification", () => {
	it("returns null below the threshold", () => {
		expect(longToolNotification({ toolName: "bash", elapsedMs: 1000 }, 5000)).toBeNull();
	});

	it("returns a notification at or above the threshold, naming the tool and the duration", () => {
		const n = longToolNotification({ toolName: "bash", elapsedMs: 62000 }, 5000);
		expect(n?.body).toContain("bash");
		expect(n?.body).toContain("1m 2s");
		expect(n?.urgency).toBe("low");
	});
});
