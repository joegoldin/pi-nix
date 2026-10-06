import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressFor, keyFileName } from "./paths.ts";
import {
	matchedPidDomain,
	nameForSocket,
	procStart,
	readEntries,
	readPeers,
	readPeerToken,
	writeEntry,
	writeKey,
} from "./registry.ts";

let root: string;
let dir: string;
const servers: Server[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "picc-"));
	dir = join(root, "sessions");
	mkdirSync(dir);
});

afterEach(() => {
	for (const s of servers.splice(0)) s.close();
	rmSync(root, { recursive: true, force: true });
});

function listenOn(path: string): Promise<void> {
	const server = createServer((s) => s.end());
	servers.push(server);
	return new Promise((resolve) => server.listen(path, resolve));
}

const put = (name: string, value: unknown) =>
	writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));

describe("readEntries", () => {
	it("reads <pid>.json entries and skips everything else", () => {
		put("10.json", { pid: 10, name: "a" });
		put("11.json", "{not json");
		put("12.json", { name: "no pid" });
		put("13.json", { pid: -1 });
		put("14.json", "null");
		put("x.json", { pid: 15 });
		put("16.json.tmp.ab12", { pid: 16 });
		put("17.abc.key", { pid: 17 });
		mkdirSync(join(dir, "18.json"));
		expect(readEntries(dir).map((e) => e.pid)).toEqual([10]);
	});

	it("returns nothing for a missing directory", () => {
		expect(readEntries(join(root, "absent"))).toEqual([]);
	});
});

describe("readPeers", () => {
	it("lists others with liveness, names and addresses", async () => {
		const live = join(root, "live 1.sock");
		await listenOn(live);
		put("20.json", { pid: 20, sessionId: "s20", cwd: "/w/alpha", status: "busy", startedAt: 5, kind: "interactive", entrypoint: "cli", messagingSocketPath: live });
		put("21.json", { pid: 21, name: "beta", messagingSocketPath: join(root, "dead.sock") });
		put("22.json", { pid: 22, name: "self", messagingSocketPath: live });
		put("23.json", { pid: 23, name: "no socket" });
		const peers = (await readPeers(dir, 22, addressFor)).sort((a, b) => a.pid - b.pid);
		expect(peers).toEqual([
			{
				pid: 20,
				sessionId: "s20",
				name: "alpha",
				cwd: "/w/alpha",
				status: "busy",
				socketPath: live,
				address: addressFor(live),
				startedAt: 5,
				kind: "interactive",
				entrypoint: "cli",
				version: undefined,
				live: true,
			},
			expect.objectContaining({ pid: 21, name: "beta", live: false }),
		]);
		expect(peers[0]?.address).toContain("live%201.sock");
	});

	it("labels a socket by the registry's name for it", () => {
		put("30.json", { pid: 30, cwd: "/w/gamma", messagingSocketPath: "/s/30.sock" });
		expect(nameForSocket(dir, "/s/30.sock")).toBe("gamma");
		expect(nameForSocket(dir, "/s/31.sock")).toBeUndefined();
	});
});

describe("procStart", () => {
	it("is ps lstart in UTC and the C locale, the string Claude compares", () => {
		const expected = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
			encoding: "utf8",
		}).trim();
		expect(procStart(process.pid)).toBe(expected);
		expect(procStart(process.pid)).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/);
	});

	it("ignores the caller's time zone", () => {
		const local = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
			env: { ...process.env, LC_ALL: "C", TZ: "Pacific/Kiritimati" },
			encoding: "utf8",
		}).trim();
		expect(procStart(process.pid)).not.toBe(local);
	});

	it("is undefined for a pid that does not exist", () => {
		expect(procStart(2 ** 22 + 7)).toBeUndefined();
	});
});

describe("matchedPidDomain", () => {
	// The parent is a real process we did not register, standing in for Claude.
	const parent = { pid: process.ppid, entrypoint: "cli", pidDomain: "darwin" };

	it("adopts the domain of an entry whose procStart we can reproduce", () => {
		expect(matchedPidDomain([{ ...parent, procStart: procStart(process.ppid) }], process.pid)).toBe("darwin");
	});

	it("adopts nothing when the procStart does not match", () => {
		expect(matchedPidDomain([{ ...parent, procStart: "Thu Jan  1 00:00:00 1970" }], process.pid)).toBeUndefined();
	});

	it("does not learn from other pi entries or itself", () => {
		const good = { ...parent, procStart: procStart(process.ppid) };
		expect(matchedPidDomain([{ ...good, entrypoint: "pi" }], process.pid)).toBeUndefined();
		expect(matchedPidDomain([good], process.ppid)).toBeUndefined();
	});
});

describe("writing", () => {
	it("writes an entry atomically, 0600, leaving no temporary file", () => {
		const path = writeEntry(dir, { pid: 40, name: "x" });
		expect(readEntries(dir)).toEqual([{ pid: 40, name: "x" }]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["40.json"]);
	});

	it("publishes a key Claude's senders find by socket hash", () => {
		const sock = join(root, "41.sock");
		const token = "0123456789abcdef0123456789abcdef";
		const path = writeKey(dir, 41, sock, { peerToken: token, procStart: "Mon Oct  5 05:53:57 2026" });
		expect(path).toBe(join(dir, keyFileName(41, sock)));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readPeerToken(dir, sock)).toBe(token);
		expect(readPeerToken(dir, join(root, "other.sock"))).toBeUndefined();
	});

	it("ignores a key with a malformed token", () => {
		const sock = join(root, "42.sock");
		writeFileSync(join(dir, keyFileName(42, sock)), JSON.stringify({ peerToken: "short" }));
		expect(readPeerToken(dir, sock)).toBeUndefined();
	});
});
