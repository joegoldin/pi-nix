// Starts the broker on demand. Ported from pi-intercom 0.16.1's broker/spawn.ts
// (MIT, Nico Bailon).
//
// The first pi session to need the broker probes the socket with a health
// request, takes an exclusive (wx) spawn lock so concurrent sessions start only
// one broker, spawns `<brokerCommand> ...brokerArgs <abs path>/broker.ts`
// detached so it outlives the session, and waits up to 5 s for it to answer.
//
// Upstream defaults to `npx --no-install tsx` and rewrites that to a Node
// command, falling back to whatever `node` is on PATH when pi itself is not
// Node. Under a Bun-built pi that silently runs the wrong runtime, or none, so
// here there is no tsx path at all: with no brokerCommand configured the
// broker runs under pi's own runtime when that is bun or node, and otherwise
// spawning fails with an error that says what to configure.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMessageReader, writeMessage } from "./framing.ts";
import {
	ensureIntercomRuntimeDir,
	getAgentDirPath,
	getBrokerLogPath,
	getBrokerPidPath,
	getBrokerSocketPath,
	getBrokerSpawnLockPath,
	getIntercomDirPath,
	INTERCOM_PROTOCOL_NAME,
	INTERCOM_PROTOCOL_VERSION,
	INTERCOM_RUNTIME_FILE_MODE,
	restrictIntercomRuntimeFile,
} from "./paths.ts";

export const BROKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");
const HEALTH_TIMEOUT_MS = 1000;
const STARTUP_TIMEOUT_MS = 5000;
const SPAWN_LOCK_STALE_MS = 10_000;
const STARTUP_LOG_LIMIT = 4000;

export interface BrokerLaunchSpec {
	command: string;
	args: string[];
}

const noop = () => {};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isBrokerHealthOkMessage(message: unknown, requestId: string): boolean {
	if (typeof message !== "object" || message === null) return false;
	const response = message as Record<string, unknown>;
	return (
		response.type === "health_ok" &&
		response.requestId === requestId &&
		response.protocol === INTERCOM_PROTOCOL_NAME &&
		response.version === INTERCOM_PROTOCOL_VERSION
	);
}

/**
 * The command that runs broker.ts. A configured brokerCommand (in this setup an
 * absolute bun store path) is used as given. Without one, pi's own runtime is
 * used if it can run broker.ts as is: bun always, node from its built-in type
 * stripping on (22.18 / 23.6).
 */
export function getBrokerLaunchSpec(
	brokerPath: string,
	brokerCommand: string | undefined,
	brokerArgs: string[] = [],
	execPath: string = process.execPath,
): BrokerLaunchSpec {
	const command = brokerCommand?.trim();
	if (command) return { command, args: [...brokerArgs, brokerPath] };
	if (/^(bun|node|nodejs)(\.exe)?$/i.test(basename(execPath))) {
		return { command: execPath, args: [...brokerArgs, brokerPath] };
	}
	throw new Error(
		`Cannot start the intercom broker: brokerCommand is not set in intercom/config.json and pi is not running under bun or node (process.execPath is ${execPath}). Set brokerCommand to an absolute bun path.`,
	);
}

export function getBrokerSpawnOptions(env: NodeJS.ProcessEnv, stderrFd: number) {
	const agentDir = getAgentDirPath(env);
	return {
		detached: true as const,
		// stderr goes to broker.log rather than a pipe: a pipe would break once
		// this pi exits, and the broker outlives it.
		stdio: ["ignore", "ignore", stderrFd] as ["ignore", "ignore", number],
		cwd: getIntercomDirPath(agentDir),
		env: { ...env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
	};
}

function readLogTail(logPath: string): string {
	try {
		return readFileSync(logPath, "utf-8").slice(-STARTUP_LOG_LIMIT).trim();
	} catch {
		return "";
	}
}

export async function spawnBrokerIfNeeded(brokerCommand: string | undefined, brokerArgs: string[] = []): Promise<void> {
	const intercomDir = getIntercomDirPath();
	ensureIntercomRuntimeDir(intercomDir);

	if (await isBrokerRunning()) return;

	const lockPath = getBrokerSpawnLockPath(intercomDir);
	if (!acquireSpawnLock(lockPath)) {
		await waitForBroker();
		return;
	}

	try {
		if (await isBrokerRunning()) return;

		const launch = getBrokerLaunchSpec(BROKER_PATH, brokerCommand, brokerArgs);
		const logPath = getBrokerLogPath(intercomDir);
		const logFd = openSync(logPath, "w", INTERCOM_RUNTIME_FILE_MODE);
		restrictIntercomRuntimeFile(logPath);
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(launch.command, launch.args, getBrokerSpawnOptions(process.env, logFd));
		} finally {
			closeSync(logFd);
		}
		child.unref();

		const startupError = (message: string, cause?: unknown) => {
			const log = readLogTail(logPath);
			const text = log ? `${message}\nBroker stderr:\n${log}` : message;
			return cause === undefined ? new Error(text) : new Error(text, { cause });
		};

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				child.off("error", onError);
				child.off("exit", onExit);
				if (error) reject(error);
				else resolve();
			};
			const onError = (error: Error) => finish(startupError(`Failed to spawn intercom broker: ${error.message}`, error));
			const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
				finish(
					startupError(
						signal
							? `Intercom broker exited before startup with signal ${signal}`
							: `Intercom broker exited before startup with code ${code ?? "unknown"}`,
					),
				);
			child.once("error", onError);
			child.once("exit", onExit);
			waitForBroker().then(
				() => finish(),
				(error: unknown) => {
					const err = error instanceof Error ? error : new Error(String(error));
					finish(startupError(err.message, err));
				},
			);
		});
	} finally {
		releaseSpawnLock(lockPath);
	}
}

async function isBrokerRunning(): Promise<boolean> {
	if (await checkSocketConnectable()) return true;
	const pidPath = getBrokerPidPath();
	if (!existsSync(pidPath)) return false;
	try {
		const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
		if (!Number.isFinite(pid)) return false;
		process.kill(pid, 0);
		return checkSocketConnectable();
	} catch {
		// Missing or unreadable pid state means there is no live broker to reuse.
		return false;
	}
}

/** True only when something on the socket answers health as pi-intercom v1. */
export function checkSocketConnectable(socketPath: string = getBrokerSocketPath()): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(socketPath);
		// Permanent: a reset arriving after finish() has removed onError must
		// not surface as an unhandled 'error' event and crash pi.
		socket.on("error", noop);
		const requestId = randomUUID();
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.off("connect", onConnect);
			socket.off("error", onError);
			socket.off("data", reader);
			socket.destroy();
			resolve(ok);
		};
		const onConnect = () => {
			try {
				writeMessage(socket, { type: "health", requestId });
			} catch {
				finish(false);
			}
		};
		const onError = () => finish(false);
		const reader = createMessageReader(
			(message) => finish(isBrokerHealthOkMessage(message, requestId)),
			() => finish(false),
		);
		socket.on("connect", onConnect);
		socket.on("error", onError);
		socket.on("data", reader);
		const timeout = setTimeout(() => finish(false), HEALTH_TIMEOUT_MS);
	});
}

function acquireSpawnLock(lockPath: string): boolean {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: "wx", mode: INTERCOM_RUNTIME_FILE_MODE });
			restrictIntercomRuntimeFile(lockPath);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!isSpawnLockStale(lockPath)) return false;
			try {
				unlinkSync(lockPath);
			} catch {
				// Another session may have removed it first; retry the wx create.
			}
		}
	}
	return false;
}

function isSpawnLockStale(lockPath: string): boolean {
	try {
		const [pidLine = "", createdAtLine = "0"] = readFileSync(lockPath, "utf-8").trim().split("\n");
		const pid = Number.parseInt(pidLine, 10);
		const createdAt = Number.parseInt(createdAtLine, 10);
		if (Number.isFinite(pid)) {
			try {
				process.kill(pid, 0);
			} catch {
				return true;
			}
		}
		return !Number.isFinite(createdAt) || Date.now() - createdAt > SPAWN_LOCK_STALE_MS;
	} catch (error) {
		// Released between the failed create and this read: its owner's broker
		// is starting or up, so wait for it rather than spawn another.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		return true;
	}
}

function releaseSpawnLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {
		// Already gone.
	}
}

async function waitForBroker(timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await checkSocketConnectable()) return;
		await sleep(100);
	}
	throw new Error("Broker failed to start within timeout");
}
