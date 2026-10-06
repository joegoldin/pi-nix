import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { getBrokerLogPath, getBrokerPidPath, getBrokerSpawnLockPath, getIntercomDirPath } from "./paths.ts";
import {
	BROKER_PATH,
	checkSocketConnectable,
	getBrokerLaunchSpec,
	getBrokerSpawnOptions,
	isBrokerHealthOkMessage,
	spawnBrokerIfNeeded,
} from "./spawn.ts";

describe("launch command", () => {
	it("runs a configured command with its args and the broker path", () => {
		expect(getBrokerLaunchSpec("/pkg/broker.ts", "/nix/store/x-bun/bin/bun", ["--smol"], "/bin/pi")).toEqual({
			command: "/nix/store/x-bun/bin/bun",
			args: ["--smol", "/pkg/broker.ts"],
		});
	});

	it("falls back to pi's own runtime when that is bun or node", () => {
		expect(getBrokerLaunchSpec("/pkg/broker.ts", undefined, [], "/usr/local/bin/bun").command).toBe("/usr/local/bin/bun");
		expect(getBrokerLaunchSpec("/pkg/broker.ts", "  ", [], "/usr/bin/node").command).toBe("/usr/bin/node");
	});

	it("refuses to guess for a compiled pi binary instead of running node from PATH", () => {
		expect(() => getBrokerLaunchSpec("/pkg/broker.ts", undefined, [], "/nix/store/y-pi/bin/pi")).toThrow(
			/brokerCommand is not set .*process\.execPath is \/nix\/store\/y-pi\/bin\/pi/,
		);
	});

	it("spawns detached in the runtime dir with stderr on the given fd", () => {
		const options = getBrokerSpawnOptions({ PI_CODING_AGENT_DIR: "/tmp/agent" }, 9);
		expect(options.detached).toBe(true);
		expect(options.stdio).toEqual(["ignore", "ignore", 9]);
		expect(options.cwd).toBe("/tmp/agent/intercom");
		expect(options.env.PI_CODING_AGENT_DIR).toBe("/tmp/agent");
	});

	it("only takes health_ok with the pi-intercom v1 marker and our request id", () => {
		expect(isBrokerHealthOkMessage({ type: "health_ok", requestId: "r", protocol: "pi-intercom", version: 1 }, "r")).toBe(true);
		expect(isBrokerHealthOkMessage({ type: "health_ok", requestId: "r" }, "r")).toBe(false);
		expect(isBrokerHealthOkMessage({ type: "health_ok", requestId: "q", protocol: "pi-intercom", version: 1 }, "r")).toBe(false);
		expect(isBrokerHealthOkMessage({ type: "health_ok", requestId: "r", protocol: "pi-intercom", version: 2 }, "r")).toBe(false);
	});
});

describe("spawning", () => {
	let agentDir: string;
	const previous = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		// Short, under /tmp: macOS caps Unix socket paths at 104 bytes.
		agentDir = mkdtempSync("/tmp/pis-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		// Wait for the broker to exit before deleting its directory, so the two
		// do not race over the runtime files.
		const pidPath = getBrokerPidPath();
		if (existsSync(pidPath)) {
			const pid = Number(readFileSync(pidPath, "utf8"));
			try {
				process.kill(pid, "SIGTERM");
				for (let i = 0; i < 100; i++) {
					process.kill(pid, 0);
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			} catch {
				// Exited.
			}
		}
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("reports the broker's stderr when it dies during startup", async () => {
		const error = await spawnBrokerIfNeeded("/bin/sh", ["-c", "echo fake broker failed >&2; exit 3", "sh"]).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Intercom broker exited before startup with code 3");
		expect((error as Error).message).toContain("Broker stderr:\nfake broker failed");
		expect(statSync(getBrokerLogPath()).mode & 0o777).toBe(0o600);
		expect(existsSync(getBrokerSpawnLockPath())).toBe(false);
	});

	it("starts one broker for concurrent callers and reuses it afterwards", async () => {
		await Promise.all([1, 2, 3].map(() => spawnBrokerIfNeeded(process.execPath, [])));
		const pid = readFileSync(getBrokerPidPath(), "utf8");
		expect(await checkSocketConnectable()).toBe(true);
		await spawnBrokerIfNeeded(process.execPath, []);
		expect(readFileSync(getBrokerPidPath(), "utf8")).toBe(pid);
		expect(existsSync(getBrokerSpawnLockPath())).toBe(false);
		expect(BROKER_PATH.endsWith("/broker/broker.ts")).toBe(true);
	}, 20_000);

	it("takes over a spawn lock left by a dead process", async () => {
		mkdirSync(getIntercomDirPath(), { recursive: true });
		writeFileSync(getBrokerSpawnLockPath(), `2147483647\n${Date.now()}\n`);
		await spawnBrokerIfNeeded(process.execPath, []);
		expect(await checkSocketConnectable()).toBe(true);
	}, 20_000);
});
