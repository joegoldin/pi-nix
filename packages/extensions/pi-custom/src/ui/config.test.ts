import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, DEFAULTS, loadConfig, normalise, saveConfig } from "./config.ts";

describe("normalise", () => {
	it("fills every key from the defaults when given nothing", () => {
		expect(normalise(undefined)).toEqual(DEFAULTS);
		expect(normalise([])).toEqual(DEFAULTS);
	});

	it("drops a wrong type back to the default for that key only", () => {
		// A hand edit that gets one key wrong should cost that key, not the file.
		const c = normalise({ toolMode: "compact", nerdIcons: "yes", collapsedLines: 3 });
		expect(c.toolMode).toBe("compact");
		expect(c.nerdIcons).toBe(DEFAULTS.nerdIcons);
		expect(c.collapsedLines).toBe(3);
	});

	it("groups tool runs unless told not to", () => {
		expect(normalise({}).groupRuns).toBe(true);
		expect(normalise({ groupRuns: false }).groupRuns).toBe(false);
		expect(normalise({ groupRuns: "no" }).groupRuns).toBe(true);
	});

	it("rejects enum values it does not know", () => {
		expect(normalise({ toolMode: "fancy" }).toolMode).toBe(DEFAULTS.toolMode);
	});

	it("clamps numbers into their range", () => {
		expect(normalise({ expandedLines: 1 }).expandedLines).toBe(10);
		expect(normalise({ diffSplitMinWidth: 10_000 }).diffSplitMinWidth).toBe(400);
	});
});

describe("the file", () => {
	it("lives beside pi's settings, honouring PI_CODING_AGENT_DIR", () => {
		expect(configPath({ PI_CODING_AGENT_DIR: "/x/agent" })).toBe("/x/agent/pi-custom.json");
	});

	it("round-trips", () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-custom-")), "pi-custom.json");
		saveConfig({ ...DEFAULTS, shimmer: false }, path);
		expect(loadConfig(path).shimmer).toBe(false);
	});

	it("falls back to defaults on a file that does not parse", () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-custom-")), "pi-custom.json");
		writeFileSync(path, "{ half written");
		expect(loadConfig(path)).toEqual(DEFAULTS);
	});

	it("writes the whole config, not a patch", () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-custom-")), "pi-custom.json");
		saveConfig(DEFAULTS, path);
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual(Object.keys(DEFAULTS));
	});
});
