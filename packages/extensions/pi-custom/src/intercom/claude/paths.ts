// Where Claude Code keeps its peer registry and sockets, and how it spells a
// socket path as a peer address. Pure, so every rule is testable without a
// filesystem.
//
// These mirror what Claude Code 2.1.286 does, observed from its behaviour and
// files rather than taken from its code: the registry is <config>/sessions,
// a socket lives at <runtime>/cc-socks/<pid>.sock unless that path is too long
// for a Unix socket, and an address is "uds:" plus the percent-encoded path.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Longest socket path Claude accepts before falling back to /tmp/cc-socks-<uid>. */
export const MAX_SOCKET_PATH_BYTES = 103;

type Env = Record<string, string | undefined>;

/** Claude's config home: CLAUDE_CONFIG_DIR when set and not blank, else ~/.claude. */
export function claudeConfigDir(env: Env = process.env, home: string = homedir()): string {
	const custom = env.CLAUDE_CONFIG_DIR?.trim();
	return (custom || join(home, ".claude")).normalize("NFC");
}

export function sessionsDir(configDir: string): string {
	return join(configDir, "sessions");
}

/** The socket path Claude would pick for a process with no live sibling to copy. */
export function defaultSocketPath(pid: number, uid: number, env: Env = process.env): string {
	const preferred = resolve(env.XDG_RUNTIME_DIR || "/tmp", "cc-socks", `${pid}.sock`);
	if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
	return join("/tmp", `cc-socks-${uid}`, `${pid}.sock`);
}

/**
 * Percent-encodes every UTF-8 byte outside [A-Za-z0-9:_/.-]. Claude validates
 * an address against that set, so a raw "~" or space would make it reject the
 * envelope and send its receipts nowhere.
 */
export function percentEncode(path: string): string {
	const encoder = new TextEncoder();
	return path.replace(/[^A-Za-z0-9:_/.\-]/gu, (ch) =>
		Array.from(encoder.encode(ch), (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
	);
}

export function addressFor(socketPath: string): string {
	return `uds:${percentEncode(socketPath)}`;
}

/** The socket path behind a "uds:" address, or undefined for anything else. */
export function socketFromAddress(address: string): string | undefined {
	if (!address.startsWith("uds:")) return undefined;
	const encoded = address.slice(4);
	if (!encoded) return undefined;
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded;
	}
}

/** How a socket file names itself in a UI: its basename without ".sock". */
export function socketLabel(socketPath: string): string {
	return basename(socketPath).replace(/\.sock$/, "");
}

/** The hash Claude uses to tie a key file to the socket it authenticates. */
export function socketHash(socketPath: string): string {
	return createHash("sha256").update(resolve(socketPath)).digest("hex");
}

export function keyFileName(pid: number, socketPath: string): string {
	return `${pid}.${socketHash(socketPath)}.key`;
}

/** Registry entries are exactly "<digits>.json"; everything else in the dir is someone else's. */
export function isEntryFileName(name: string): boolean {
	return /^\d+\.json$/.test(name);
}

/** `ps -o lstart=` in the C locale: "Mon Oct  5 05:53:57 2026". */
export function isProcStart(text: string): boolean {
	return /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(text);
}

/** pi-<dir>, the name a pi session goes by in Claude's ListAgents until the user names it. */
export function derivedName(cwd: string): string {
	const slug = basename(cwd).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32);
	return `pi-${slug || "session"}`;
}
