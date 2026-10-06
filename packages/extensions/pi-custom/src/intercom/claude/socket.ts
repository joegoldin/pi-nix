// Unix socket plumbing for Claude Code peers: probing, binding our endpoint
// safely, reading connections line by line, and sending one message per
// connection. Thin I/O; what the lines mean is frames.ts's business.
//
// Claude's sender writes, half-closes, and counts the send as done only when
// the socket fully closes, timing out after 5 s. So the listener ends its own
// side as soon as the client's end arrives, and the sender here does the same
// dance in the other direction.

import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { LineBuffer, MAX_LINE } from "./frames.ts";

export const FIRST_LINE_MS = 2000;
export const IDLE_MS = 30_000;
export const SEND_TIMEOUT_MS = 5000;

/** Whether something accepts connections on the socket within timeoutMs. */
export function probe(path: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect({ path });
		const done = (ok: boolean) => {
			clearTimeout(timer);
			s.destroy();
			resolve(ok);
		};
		const timer = setTimeout(() => done(false), timeoutMs);
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});
}

/**
 * Makes sure dir exists as a directory we own that nobody else can write to,
 * mode 0700. Refuses a symlink, someone else's directory, or one open to the
 * group or world: whoever controls it could swap our socket for theirs.
 */
export function prepareDir(dir: string, uid: number): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = lstatSync(dir);
	if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
	if (st.uid !== uid) throw new Error(`${dir} is owned by uid ${st.uid}, not ${uid}`);
	if (st.mode & 0o022) throw new Error(`${dir} is writable by group or others`);
	if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/**
 * Frees path for us to bind. A socket nobody answers on is a leftover and is
 * removed; one that answers belongs to a live process, so the caller gets a
 * sibling name instead, as Claude does.
 */
export async function claimPath(path: string): Promise<string> {
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return path;
	}
	if (st.isSocket() && !(await probe(path, 250))) {
		unlinkSync(path);
		return path;
	}
	return path.replace(/\.sock$/, `-${randomBytes(4).toString("hex")}.sock`);
}

export interface Connection {
	/** Called for each complete line, in order. */
	line(text: string): void;
}

export interface Listener {
	/** Stops listening and drops any connection still open. */
	close(): Promise<void>;
}

/**
 * Listens on path (mode 0600) and hands each connection's lines to a fresh
 * Connection. A connection that sends nothing complete within FIRST_LINE_MS,
 * goes quiet for IDLE_MS, or sends a line over MAX_LINE is dropped.
 */
export function listen(path: string, onConnection: () => Connection): Promise<Listener> {
	const open = new Set<Socket>();
	const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
		open.add(socket);
		const conn = onConnection();
		const buffer = new LineBuffer(MAX_LINE);
		let gotLine = false;
		const firstLine = setTimeout(() => socket.destroy(), FIRST_LINE_MS);
		const deliver = (lines: string[]) => {
			for (const l of lines) {
				gotLine = true;
				try {
					conn.line(l);
				} catch {
					// A handler's failure is not the sender's problem.
				}
			}
			if (gotLine) clearTimeout(firstLine);
		};
		socket.setEncoding("utf8");
		socket.setTimeout(IDLE_MS, () => socket.destroy());
		socket.on("data", (chunk: string) => {
			const { lines, overflow } = buffer.push(chunk);
			if (overflow) {
				clearTimeout(firstLine);
				socket.destroy();
				return;
			}
			deliver(lines);
		});
		socket.on("end", () => {
			const rest = buffer.flush();
			deliver(rest === undefined ? [] : [rest]);
			clearTimeout(firstLine);
			socket.end();
		});
		socket.on("close", () => {
			clearTimeout(firstLine);
			open.delete(socket);
		});
		// Resets and late errors after close must never surface as uncaught.
		socket.on("error", () => {});
	});
	server.on("error", () => {});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			try {
				chmodSync(path, 0o600);
			} catch (err) {
				server.close();
				reject(err);
				return;
			}
			resolve({
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
						for (const s of open) s.destroy();
					}),
			});
		});
	});
}

/**
 * Sends data on a fresh connection, half-closes, and resolves once the peer
 * has closed its side too. Either step taking over timeoutMs is an error.
 */
export function sendRaw(path: string, data: string, timeoutMs = SEND_TIMEOUT_MS): Promise<void> {
	return new Promise((resolve, reject) => {
		const s = connect({ path });
		let failed: Error | undefined;
		const fail = (err: Error) => {
			failed ??= err;
			s.destroy();
		};
		let timer = setTimeout(() => fail(new Error(`Timed out connecting to ${path}`)), timeoutMs);
		s.once("connect", () => {
			clearTimeout(timer);
			timer = setTimeout(() => fail(new Error(`Timed out waiting for ${path} to close`)), timeoutMs);
			s.end(data);
		});
		s.on("error", (err) => fail(err));
		s.once("close", () => {
			clearTimeout(timer);
			if (failed) reject(failed);
			else resolve();
		});
		// Nothing is expected back; reading keeps the socket flowing so the
		// peer's FIN is seen.
		s.resume();
	});
}
