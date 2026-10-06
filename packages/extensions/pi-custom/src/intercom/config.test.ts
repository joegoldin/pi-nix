import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askTimeoutMs, DEFAULT_ASK_TIMEOUT_MS, loadConfig, parseConfig } from "./config.ts";

function agentDir(config?: string): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "intercom-config-"));
	if (config !== undefined) {
		mkdirSync(join(dir, "intercom"));
		writeFileSync(join(dir, "intercom", "config.json"), config);
	}
	return { PI_CODING_AGENT_DIR: dir };
}

describe("loadConfig", () => {
	it("is off without a file", () => {
		const config = loadConfig(agentDir());
		expect(config.enabled).toBe(false);
		expect(config.disabledReason).toBeUndefined();
	});

	it("is on with a file, with pi-nix's defaults", () => {
		const config = loadConfig(agentDir("{}"));
		expect(config.enabled).toBe(true);
		expect(config.inboundTrigger).toBe("replies");
		expect(config.claude).toEqual({ enabled: true, fromMode: "prompting" });
	});

	it("turns off with a reason rather than throwing on a malformed file", () => {
		const config = loadConfig(agentDir("{ not json"));
		expect(config.enabled).toBe(false);
		expect(config.disabledReason).toContain("config.json");
	});

	it("turns off on a bad value", () => {
		const config = loadConfig(agentDir(JSON.stringify({ inboundTrigger: "sometimes" })));
		expect(config.enabled).toBe(false);
		expect(config.disabledReason).toContain("inboundTrigger");
	});

	it("reads what the messaging option writes", () => {
		const config = loadConfig(
			agentDir(JSON.stringify({ brokerCommand: "/nix/store/x-bun/bin/bun", brokerArgs: [], enabled: true, inboundTrigger: "replies", confirmSend: false, replyHint: true })),
		);
		expect(config.enabled).toBe(true);
		expect(config.brokerCommand).toBe("/nix/store/x-bun/bin/bun");
	});
});

describe("parseConfig", () => {
	it("reads the claude section", () => {
		expect(parseConfig({ claude: { enabled: false, fromMode: "bypass" } }).claude).toEqual({ enabled: false, fromMode: "bypass" });
	});

	it("rejects a non-object", () => {
		expect(() => parseConfig([])).toThrow("JSON object");
	});

	it("ignores keys it does not know, like pi-intercom's crossMachine", () => {
		expect(parseConfig({ crossMachine: { machineName: "x" } }).enabled).toBe(true);
	});
});

describe("askTimeoutMs", () => {
	it("defaults, reads, and ignores nonsense", () => {
		expect(askTimeoutMs({})).toBe(DEFAULT_ASK_TIMEOUT_MS);
		expect(askTimeoutMs({ PI_INTERCOM_ASK_TIMEOUT_MS: "300000" })).toBe(300000);
		expect(askTimeoutMs({ PI_INTERCOM_ASK_TIMEOUT_MS: "-1" })).toBe(DEFAULT_ASK_TIMEOUT_MS);
	});
});
