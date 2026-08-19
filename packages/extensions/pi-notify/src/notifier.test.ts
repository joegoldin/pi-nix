import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { createToolClock, escapeAppleScript, longToolNotification, notifierArgs } from "./notifier.ts";

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
