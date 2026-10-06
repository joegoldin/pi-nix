// Where the broker lives and who may reach it. Ported from pi-intercom 0.16.1's
// broker/paths.ts, runtime-claim.ts and cwd.ts (MIT, Nico Bailon).
//
// One broker per agent dir, reached over the Unix socket
// $PI_CODING_AGENT_DIR/intercom/broker.sock. The directory is 0700 and every
// file in it 0600, which is the whole access control: only this user can
// connect. Upstream's Windows named pipe and opt-in TCP transport are gone;
// this setup runs on macOS and Linux only.

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const INTERCOM_DIR_MODE = 0o700;
export const INTERCOM_RUNTIME_FILE_MODE = 0o600;
export const INTERCOM_PROTOCOL_NAME = "pi-intercom";
export const INTERCOM_PROTOCOL_VERSION = 1;
export const INTERCOM_SCOPE_ID_ENV = "PI_INTERCOM_SCOPE_ID";

export function getAgentDirPath(
	env: NodeJS.ProcessEnv = process.env,
	homeDir: string = homedir(),
	cwd: string = process.cwd(),
): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homeDir, ".pi/agent");
	return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

export function getIntercomDirPath(agentDir: string = getAgentDirPath()): string {
	return join(agentDir, "intercom");
}

export function getBrokerSocketPath(agentDir: string = getAgentDirPath()): string {
	return join(getIntercomDirPath(agentDir), "broker.sock");
}

export function getBrokerPidPath(intercomDir: string = getIntercomDirPath()): string {
	return join(intercomDir, "broker.pid");
}

export function getBrokerSpawnLockPath(intercomDir: string = getIntercomDirPath()): string {
	return join(intercomDir, "broker.spawn.lock");
}

export function getBrokerLogPath(intercomDir: string = getIntercomDirPath()): string {
	return join(intercomDir, "broker.log");
}

/** Sessions with different scope ids share a broker but cannot see or reach each other. */
export function getIntercomScopeId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const scopeId = env[INTERCOM_SCOPE_ID_ENV]?.trim();
	return scopeId ? scopeId : undefined;
}

/** Creates the runtime dir and repairs its mode if something loosened it. */
export function ensureIntercomRuntimeDir(intercomDir: string = getIntercomDirPath()): void {
	mkdirSync(intercomDir, { recursive: true, mode: INTERCOM_DIR_MODE });
	chmodSync(intercomDir, INTERCOM_DIR_MODE);
}

export function restrictIntercomRuntimeFile(filePath: string): void {
	chmodSync(filePath, INTERCOM_RUNTIME_FILE_MODE);
}

/**
 * Throws when broker.pid names a live process. A second broker would unlink
 * the first one's socket and split the sessions between two rosters.
 */
export function assertNoLiveBroker(pidPath: string): void {
	if (!existsSync(pidPath)) return;
	let pid: number;
	try {
		pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
	} catch {
		return;
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		throw error;
	}
	throw new Error(`Refusing to replace live intercom broker process ${pid}`);
}

// A relaunch can report the same directory differently: a trailing slash, a
// "." segment, or a symlink such as macOS /tmp vs /private/tmp. resolve()
// collapses the lexical forms and realpath the symlinks, falling back to the
// resolved path once the directory is gone. Memoized: the set of cwds is small.
const normalizeCache = new Map<string, string>();

export function normalizeCwd(cwd: string): string {
	const cached = normalizeCache.get(cwd);
	if (cached !== undefined) return cached;
	const resolved = resolve(cwd);
	let normalized: string;
	try {
		normalized = realpathSync(resolved);
	} catch {
		normalized = resolved;
	}
	normalizeCache.set(cwd, normalized);
	return normalized;
}

export function sameCwd(a: string, b: string): boolean {
	return normalizeCwd(a) === normalizeCwd(b);
}
