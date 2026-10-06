// Claude Code's session registry on disk: one <pid>.json per live session and
// one <pid>.<hash>.key per socket that wants its senders to authenticate.
// Thin I/O over paths.ts.
//
// The directory is shared with every Claude session of this user, so reads
// tolerate whatever else is in it, and writes go through a temporary file and
// a rename so a reader never sees half an entry.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isEntryFileName, isProcStart, keyFileName, socketHash } from "./paths.ts";
import { probe } from "./socket.ts";

const MAX_KEY_BYTES = 4096;
const PROBE_MS = 250;

/** The fields of a registry entry this module reads or writes. Claude's own entries carry more. */
export interface RegistryEntry {
	pid: number;
	sessionId?: string;
	cwd?: string;
	startedAt?: number;
	procStart?: string;
	pidDomain?: string;
	version?: string;
	peerProtocol?: number;
	peerFeatures?: string[];
	kind?: string;
	entrypoint?: string;
	messagingSocketPath?: string;
	name?: string;
	nameSource?: string;
	nameSince?: number;
	status?: string;
	updatedAt?: number;
	statusUpdatedAt?: number;
}

export interface Peer {
	pid: number;
	sessionId?: string;
	/** entry.name, else the basename of its cwd: what Claude's ListAgents shows. */
	name: string;
	cwd?: string;
	status?: string;
	socketPath: string;
	address: string;
	startedAt?: number;
	kind?: string;
	/** "pi" for pi sessions registered by this transport, "cli" and others for Claude's own. */
	entrypoint?: string;
	version?: string;
	/** Whether the socket accepted a connection just now. */
	live: boolean;
}

/** Every well-formed entry in the registry. Unreadable or foreign files are skipped. */
export function readEntries(dir: string): RegistryEntry[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const name of names) {
		if (!isEntryFileName(name)) continue;
		try {
			const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (!value || typeof value !== "object") continue;
			const e = value as RegistryEntry;
			if (!Number.isInteger(e.pid) || e.pid <= 0) continue;
			out.push(e);
		} catch {
			// Mid-write, deleted under us, or not JSON: not a peer.
		}
	}
	return out;
}

function peerName(e: RegistryEntry): string {
	return (typeof e.name === "string" && e.name) || (typeof e.cwd === "string" && basename(e.cwd)) || String(e.pid);
}

/** Peers in the registry other than selfPid, each probed for a listening socket. */
export async function readPeers(dir: string, selfPid: number, addressFor: (path: string) => string): Promise<Peer[]> {
	const entries = readEntries(dir).filter(
		(e) => e.pid !== selfPid && typeof e.messagingSocketPath === "string" && e.messagingSocketPath !== "",
	);
	return Promise.all(
		entries.map(async (e) => {
			const socketPath = e.messagingSocketPath as string;
			return {
				pid: e.pid,
				sessionId: typeof e.sessionId === "string" ? e.sessionId : undefined,
				name: peerName(e),
				cwd: typeof e.cwd === "string" ? e.cwd : undefined,
				status: typeof e.status === "string" ? e.status : undefined,
				socketPath,
				address: addressFor(socketPath),
				startedAt: typeof e.startedAt === "number" ? e.startedAt : undefined,
				kind: typeof e.kind === "string" ? e.kind : undefined,
				entrypoint: typeof e.entrypoint === "string" ? e.entrypoint : undefined,
				version: typeof e.version === "string" ? e.version : undefined,
				live: await probe(socketPath, PROBE_MS),
			};
		}),
	);
}

/** The name a socket's owner goes by in the registry, for labelling what it sends. */
export function nameForSocket(dir: string, socketPath: string): string | undefined {
	const e = readEntries(dir).find((x) => x.messagingSocketPath === socketPath);
	return e ? peerName(e) : undefined;
}

/**
 * A process's start time as Claude records it: `ps -o lstart=` in the C
 * locale and UTC. Claude compares the string exactly to spot a recycled pid,
 * so local time here would get our entry hidden.
 */
export function procStart(pid: number): string | undefined {
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
		return isProcStart(out) ? out : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The pidDomain live Claude sessions on this machine use, taken from an entry
 * whose procStart we can reproduce for its pid, which proves we see the same
 * pids it does. Undefined when there is no such entry: without pidDomain
 * Claude lists us whenever our socket answers, which is the safe failure.
 */
export function matchedPidDomain(entries: RegistryEntry[], selfPid: number): string | undefined {
	for (const e of entries) {
		if (e.pid === selfPid || e.entrypoint === "pi" || typeof e.pidDomain !== "string" || !e.procStart) continue;
		if (procStart(e.pid) === e.procStart) return e.pidDomain;
	}
	return undefined;
}

/** Writes a file through a temporary sibling and a rename, mode 0600. */
export function writeAtomic(path: string, data: string): void {
	const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
	try {
		writeFileSync(tmp, data, { mode: 0o600 });
		renameSync(tmp, path);
	} catch (err) {
		removeFile(tmp);
		throw err;
	}
}

export function removeFile(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone.
	}
}

export function writeEntry(dir: string, entry: RegistryEntry): string {
	const path = join(dir, `${entry.pid}.json`);
	try {
		writeAtomic(path, JSON.stringify(entry));
	} catch {
		// Claude deletes non-canonical names in this directory; if it took our
		// temporary file between write and rename, the second try wins.
		writeAtomic(path, JSON.stringify(entry));
	}
	return path;
}

export interface KeyFile {
	peerToken: string;
	procStart?: string;
	pidDomain?: string;
}

/** Publishes our token. The ".key.tmp." spelling is the one Claude sweeps if we die mid-write. */
export function writeKey(dir: string, pid: number, socketPath: string, key: KeyFile): string {
	const path = join(dir, keyFileName(pid, socketPath));
	writeAtomic(path, JSON.stringify(key));
	return path;
}

/** The peer token published for a socket, found by the socket's hash as Claude finds it. */
export function readPeerToken(dir: string, socketPath: string): string | undefined {
	const suffix = `.${socketHash(socketPath)}.key`;
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(suffix) && /^\d+\./.test(n));
	} catch {
		return undefined;
	}
	for (const name of names) {
		try {
			const path = join(dir, name);
			if (statSync(path).size > MAX_KEY_BYTES) continue;
			const value = JSON.parse(readFileSync(path, "utf8")) as Partial<KeyFile>;
			if (typeof value.peerToken === "string" && /^[0-9a-f]{32}$/.test(value.peerToken)) return value.peerToken;
		} catch {
			// A half-written or foreign file; try the next.
		}
	}
	return undefined;
}
