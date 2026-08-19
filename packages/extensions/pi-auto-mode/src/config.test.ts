import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";

const reader = (contents: Record<string, string>) => (path: string) => {
	if (!(path in contents)) throw new Error(`ENOENT: ${path}`);
	return contents[path]!;
};

describe("loadConfig", () => {
	it("is disabled when the env var is unset, so an unconfigured pi behaves natively", () => {
		expect(loadConfig(reader({}), {})).toEqual({ ...DEFAULT_CONFIG, enabled: false });
	});

	it("is disabled when the file is missing", () => {
		expect(loadConfig(reader({}), { PI_AUTO_MODE_CONFIG: "/nix/store/gone.json" }).enabled).toBe(false);
	});

	it("merges a well-formed file over the defaults", () => {
		const cfg = loadConfig(
			reader({ "/c.json": JSON.stringify({ enabled: true, hard_deny: ["no ssh keys"], userTurnLimit: 3 }) }),
			{ PI_AUTO_MODE_CONFIG: "/c.json" },
		);
		expect(cfg.enabled).toBe(true);
		expect(cfg.hard_deny).toEqual(["no ssh keys"]);
		expect(cfg.userTurnLimit).toBe(3);
		expect(cfg.allow).toEqual([]);
	});

	it("fails closed on malformed JSON: enabled with no deterministic allows", () => {
		const cfg = loadConfig(reader({ "/c.json": "{not json" }), { PI_AUTO_MODE_CONFIG: "/c.json" });
		expect(cfg.enabled).toBe(true);
		expect(cfg.deterministic.allow).toEqual([]);
	});

	it("fails closed when the file parses but is not an object", () => {
		const cfg = loadConfig(reader({ "/c.json": "[1,2]" }), { PI_AUTO_MODE_CONFIG: "/c.json" });
		expect(cfg.enabled).toBe(true);
		expect(cfg.deterministic.allow).toEqual([]);
	});

	it("drops non-string entries from rule lists rather than trusting them", () => {
		const cfg = loadConfig(reader({ "/c.json": JSON.stringify({ enabled: true, allow: ["ok", 7, null] }) }), {
			PI_AUTO_MODE_CONFIG: "/c.json",
		});
		expect(cfg.allow).toEqual(["ok"]);
	});
});
