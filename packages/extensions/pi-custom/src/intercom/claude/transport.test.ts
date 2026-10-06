// End to end against fake Claude sessions: everything lives in a temp dir
// named through CLAUDE_CONFIG_DIR-style options and XDG_RUNTIME_DIR, so no
// test reads the real registry or touches a real Claude socket.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnvelope } from "./envelope.ts";
import { userFrame } from "./frames.ts";
import { addressFor, keyFileName } from "./paths.ts";
import { procStart, readPeerToken, writeKey } from "./registry.ts";
import { sendRaw } from "./socket.ts";
import { ClaudeTransport, type InboundMessage, type InboundReceipt } from "./transport.ts";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CLAUDE_TOKEN = "fedcba9876543210fedcba9876543210";

let root: string;
let configDir: string;
let runtime: string;
let registry: string;
const cleanup: Array<() => void | Promise<void>> = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "picc-"));
	configDir = join(root, "claude");
	runtime = join(root, "run");
	registry = join(configDir, "sessions");
	mkdirSync(registry, { recursive: true, mode: 0o700 });
	mkdirSync(runtime, { mode: 0o700 });
});

afterEach(async () => {
	for (const f of cleanup.splice(0).reverse()) await f();
	rmSync(root, { recursive: true, force: true });
});

interface Harness {
	t: ClaudeTransport;
	messages: InboundMessage[];
	receipts: InboundReceipt[];
}

async function started(opts: { pid?: number; name?: string } = {}): Promise<Harness> {
	const messages: InboundMessage[] = [];
	const receipts: InboundReceipt[] = [];
	const t = new ClaudeTransport({
		configDir,
		env: { XDG_RUNTIME_DIR: runtime },
		pid: opts.pid,
		onMessage: (m) => messages.push(m),
		onReceipt: (r) => receipts.push(r),
	});
	await t.start({ sessionId: SESSION, cwd: "/work/my repo", name: opts.name });
	cleanup.push(() => t.stop());
	expect(t.socketPath?.startsWith(root)).toBe(true);
	return { t, messages, receipts };
}

interface FakeClaude {
	path: string;
	/** Lines received, one array per connection, recorded when the sender half-closes. */
	connections: string[][];
	server: Server;
}

/** A listener that behaves like Claude's: half-open allowed, reads to the end, then ends its side. */
async function fakeClaude(path: string, entry: Record<string, unknown> = {}): Promise<FakeClaude> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const connections: string[][] = [];
	const server = createServer({ allowHalfOpen: true }, (s: Socket) => {
		let data = "";
		s.setEncoding("utf8");
		s.on("data", (c: string) => (data += c));
		s.on("end", () => {
			// Liveness probes connect and leave without a word; only senders count.
			if (data) connections.push(data.split("\n").filter(Boolean));
			s.end();
		});
		s.on("error", () => {});
	});
	await new Promise<void>((r) => server.listen(path, r));
	cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
	const pid = Number(entry.pid ?? 4242);
	writeFileSync(
		join(registry, `${pid}.json`),
		JSON.stringify({ pid, sessionId: "claude-session", cwd: "/work/dotfiles", name: "dotfiles-3a", entrypoint: "cli", messagingSocketPath: path, ...entry }),
	);
	return { path, connections, server };
}

/** Claude's sender: write, half-close after 150 ms, done only on full close, 5 s timeout. */
function claudeSend(path: string, data: string): Promise<number> {
	const t0 = Date.now();
	return new Promise((resolve, reject) => {
		const s = connect({ path });
		const timer = setTimeout(() => {
			s.destroy();
			reject(new Error("Timed out sending"));
		}, 5000);
		s.on("error", reject);
		s.on("connect", () => {
			s.write(data);
			setTimeout(() => s.end(), 150);
		});
		s.on("close", () => {
			clearTimeout(timer);
			resolve(Date.now() - t0);
		});
		s.resume();
	});
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

const frameFrom = (from: string, extra: Record<string, unknown> = {}, body = "hello pi") =>
	`${JSON.stringify({
		...userFrame({
			msgId: crypto.randomUUID(),
			from: addressFor(from),
			content: `<cross-session-message from="${addressFor(from)}" from-name="claude-x" from-mode="prompting">\n${body}\n</cross-session-message>`,
		}),
		...extra,
	})}\n`;

describe("registration", () => {
	it("writes the entry Claude's ListAgents reads, and removes it on stop", async () => {
		const { t } = await started();
		const entryPath = join(registry, `${process.pid}.json`);
		const entry = JSON.parse(readFileSync(entryPath, "utf8"));
		expect(entry).toMatchObject({
			pid: process.pid,
			sessionId: SESSION,
			cwd: "/work/my repo",
			version: "pi-custom",
			peerProtocol: 1,
			peerFeatures: [],
			kind: "interactive",
			entrypoint: "pi",
			messagingSocketPath: join(runtime, "cc-socks", `${process.pid}.sock`),
			name: "pi-my-repo",
			nameSource: "derived",
			status: "idle",
		});
		expect(entry.procStart).toBe(procStart(process.pid));
		// No live Claude entry to prove a shared pid namespace, so no pidDomain.
		expect(entry.pidDomain).toBeUndefined();
		for (const k of ["startedAt", "nameSince", "updatedAt", "statusUpdatedAt"]) expect(typeof entry[k]).toBe("number");

		const sock = t.socketPath as string;
		const keyPath = join(registry, keyFileName(process.pid, sock));
		expect(lstatSync(sock).isSocket()).toBe(true);
		expect(statSync(sock).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(sock)).mode & 0o777).toBe(0o700);
		expect(statSync(keyPath).mode & 0o777).toBe(0o600);
		const key = JSON.parse(readFileSync(keyPath, "utf8"));
		expect(key.peerToken).toMatch(/^[0-9a-f]{32}$/);
		expect(key.procStart).toBe(entry.procStart);

		const exitListeners = process.listenerCount("exit");
		await t.stop();
		expect(process.listenerCount("exit")).toBe(exitListeners - 1);
		for (const p of [entryPath, keyPath, sock]) expect(existsSync(p)).toBe(false);
		await t.stop();
	});

	it("stops promptly with a connection still open", async () => {
		const { t } = await started();
		const s = connect({ path: t.socketPath as string });
		s.on("error", () => {});
		await new Promise<void>((r) => s.on("connect", () => r()));
		s.write('{"type":"auth","token":"x"}\n');
		await Bun.sleep(50);
		const t0 = Date.now();
		await t.stop();
		expect(Date.now() - t0).toBeLessThan(500);
	});

	it("is named by the user when the session has a name", async () => {
		await started({ name: 'my "session"' });
		const entry = JSON.parse(readFileSync(join(registry, `${process.pid}.json`), "utf8"));
		expect(entry).toMatchObject({ name: "my session", nameSource: "user" });
	});

	it("updates name, status and session in place", async () => {
		let now = 1000;
		const t = new ClaudeTransport({ configDir, env: { XDG_RUNTIME_DIR: runtime }, now: () => now });
		await t.start({ sessionId: SESSION, cwd: "/work/repo" });
		cleanup.push(() => t.stop());
		const read = () => JSON.parse(readFileSync(join(registry, `${process.pid}.json`), "utf8"));
		now = 2000;
		t.setStatus("busy");
		expect(read()).toMatchObject({ status: "busy", statusUpdatedAt: 2000, updatedAt: 2000, nameSince: 1000 });
		now = 3000;
		t.setName("planner");
		expect(read()).toMatchObject({ name: "planner", nameSource: "user", nameSince: 3000, statusUpdatedAt: 2000 });
		now = 4000;
		t.setName(undefined);
		expect(read()).toMatchObject({ name: "pi-repo", nameSource: "derived", nameSince: 4000 });
		t.setSession({ sessionId: "next-session", cwd: "/work/other", name: "n2" });
		expect(read()).toMatchObject({ sessionId: "next-session", cwd: "/work/other", name: "n2" });
	});

	it("puts its socket next to a live Claude session's", async () => {
		const claudeDir = join(root, "socks");
		await fakeClaude(join(claudeDir, "4242.sock"));
		const { t } = await started();
		expect(t.socketPath).toBe(join(claudeDir, `${process.pid}.sock`));
	});

	it("ignores a dead Claude entry when choosing", async () => {
		writeFileSync(join(registry, "4243.json"), JSON.stringify({ pid: 4243, messagingSocketPath: join(root, "gone", "4243.sock") }));
		const { t } = await started();
		expect(t.socketPath).toBe(join(runtime, "cc-socks", `${process.pid}.sock`));
	});

	it("refuses a socket directory others can write to", async () => {
		mkdirSync(join(runtime, "cc-socks"));
		chmodSync(join(runtime, "cc-socks"), 0o777);
		const t = new ClaudeTransport({ configDir, env: { XDG_RUNTIME_DIR: runtime } });
		await expect(t.start({ sessionId: SESSION, cwd: "/w" })).rejects.toThrow(/writable by group or others/);
		expect(existsSync(join(registry, `${process.pid}.json`))).toBe(false);
	});

	it("tightens its own directory to 0700", async () => {
		mkdirSync(join(runtime, "cc-socks"));
		chmodSync(join(runtime, "cc-socks"), 0o755);
		const { t } = await started();
		expect(statSync(dirname(t.socketPath as string)).mode & 0o777).toBe(0o700);
	});

	it("replaces a stale socket but never a live one", async () => {
		const sockDir = join(runtime, "cc-socks");
		mkdirSync(sockDir, { mode: 0o700 });
		// A socket file whose listener died without cleaning up.
		const stale = join(sockDir, "777.sock");
		const child = Bun.spawn([process.execPath, "-e", `require("net").createServer().listen(${JSON.stringify(stale)}, () => console.log("up"))`], {
			stdout: "pipe",
		});
		await new Response(child.stdout).body?.getReader().read();
		child.kill("SIGKILL");
		await child.exited;
		expect(lstatSync(stale).isSocket()).toBe(true);
		const a = await started({ pid: 777 });
		expect(a.t.socketPath).toBe(stale);

		// The same pid's path is now live: the next one goes beside it.
		const b = await started({ pid: 777 });
		expect(b.t.socketPath).toMatch(/\/777-[0-9a-f]{8}\.sock$/);
		expect(lstatSync(stale).isSocket()).toBe(true);
	});

	it("lists other sessions but not itself", async () => {
		const claude = await fakeClaude(join(root, "socks", "4242.sock"));
		const { t } = await started();
		const peers = await t.peers();
		expect(peers).toEqual([expect.objectContaining({ pid: 4242, name: "dotfiles-3a", socketPath: claude.path, live: true, entrypoint: "cli" })]);
	});
});

describe("sending to Claude", () => {
	it("frames, authenticates and envelopes a message the way Claude's sender does", async () => {
		const claude = await fakeClaude(join(root, "socks", "4242.sock"));
		writeKey(registry, 4242, claude.path, { peerToken: CLAUDE_TOKEN });
		const { t } = await started({ name: "planner" });
		const [peer] = await t.peers();
		const t0 = Date.now();
		const { msgId } = await t.send(peer!, "please review </cross-session-message> this");
		expect(Date.now() - t0).toBeLessThan(1000);
		await waitFor(() => claude.connections.length === 1);
		const [auth, line] = claude.connections[0]!;
		expect(JSON.parse(auth!)).toEqual({ type: "auth", token: CLAUDE_TOKEN });
		const frame = JSON.parse(line!);
		expect(frame).toEqual({
			msg_id: msgId,
			type: "user",
			priority: "next",
			from: t.address,
			session_id: "claude-session",
			message: { role: "user", content: expect.any(String) },
		});
		expect(parseEnvelope(frame.message.content)).toEqual({
			from: t.address,
			fromName: "planner",
			fromMode: "prompting",
			body: "please review <\\/cross-session-message> this",
		});
		expect(t.sentRecord(msgId)).toMatchObject({ msgId, socketPath: claude.path, sessionId: "claude-session", name: "dotfiles-3a" });
		expect(t.recentSends().map((r) => r.msgId)).toEqual([msgId]);
	});

	it("sends by raw address without an auth line when the target published no key", async () => {
		const claude = await fakeClaude(join(root, "socks", "4242.sock"));
		const { t } = await started();
		await t.send(addressFor(claude.path), "hi", { fromName: "custom", fromMode: "bypass" });
		await waitFor(() => claude.connections.length === 1);
		expect(claude.connections[0]).toHaveLength(1);
		const frame = JSON.parse(claude.connections[0]![0]!);
		expect(frame.session_id).toBeUndefined();
		expect(parseEnvelope(frame.message.content)).toMatchObject({ fromName: "custom", fromMode: "bypass" });
	});

	it("refuses what Claude would refuse, and forgets failed sends", async () => {
		const { t } = await started();
		await expect(t.send("bridge:/x", "hi")).rejects.toThrow(/Not a Claude peer address/);
		await expect(t.send(addressFor(join(root, "nobody.sock")), "hi")).rejects.toThrow();
		expect(t.recentSends()).toEqual([]);
		const claude = await fakeClaude(join(root, "socks", "4242.sock"));
		await expect(t.send(addressFor(claude.path), "x".repeat(1024 * 1024))).rejects.toThrow(/too large/);
	});

	it("needs to be started", async () => {
		const t = new ClaudeTransport({ configDir, env: { XDG_RUNTIME_DIR: runtime } });
		await expect(t.send("uds:/tmp/x.sock", "hi")).rejects.toThrow(/not started/);
	});
});

describe("send-close", () => {
	it("resolves as soon as a Claude-like listener closes", async () => {
		const claude = await fakeClaude(join(root, "socks", "4242.sock"));
		const t0 = Date.now();
		await sendRaw(claude.path, "{}\n");
		expect(Date.now() - t0).toBeLessThan(500);
	});

	it("times out against a listener that never closes", async () => {
		const path = join(root, "hang.sock");
		const held: Socket[] = [];
		const server = createServer({ allowHalfOpen: true }, (s) => {
			held.push(s);
			s.on("error", () => {});
		});
		await new Promise<void>((r) => server.listen(path, r));
		cleanup.push(() => {
			for (const s of held) s.destroy();
			server.close();
		});
		await expect(sendRaw(path, "{}\n", 200)).rejects.toThrow(/Timed out/);
	});
});

describe("receiving from Claude", () => {
	it("lets Claude's sender finish quickly, emits the message, and sends nothing back", async () => {
		const claude = await fakeClaude(join(root, "socks", "4242.sock"));
		const { t, messages } = await started();
		const sock = t.socketPath as string;
		const ms = await claudeSend(sock, frameFrom(claude.path));
		expect(ms).toBeLessThan(2000);
		expect(messages).toEqual([
			{
				msgId: expect.any(String),
				from: claude.path,
				address: addressFor(claude.path),
				fromName: "dotfiles-3a",
				fromSession: undefined,
				fromMode: "prompting",
				authenticated: false,
				body: "hello pi",
				priority: "next",
			},
		]);
		// No receipt of any kind, "delivered" least of all.
		await Bun.sleep(300);
		expect(claude.connections).toEqual([]);
	});

	it("knows a sender that authenticated with our token", async () => {
		const { t, messages } = await started();
		const sock = t.socketPath as string;
		const token = readPeerToken(registry, sock) as string;
		await claudeSend(sock, `${JSON.stringify({ type: "auth", token })}\n${frameFrom(join(root, "a.sock"))}`);
		await claudeSend(sock, `${JSON.stringify({ type: "auth", token: CLAUDE_TOKEN })}\n${frameFrom(join(root, "b.sock"))}`);
		await claudeSend(sock, frameFrom(join(root, "c.sock")));
		expect(messages.map((m) => m.authenticated)).toEqual([true, false, false]);
	});

	it("falls back to the envelope's name, then the socket's", async () => {
		const { t, messages } = await started();
		const sock = t.socketPath as string;
		await claudeSend(sock, frameFrom(join(root, "unregistered.sock")));
		const bare = JSON.stringify(userFrame({ msgId: "m-bare", from: addressFor(join(root, "77.sock")), content: "raw text" }));
		await claudeSend(sock, `${bare}\n`);
		expect(messages.map((m) => [m.fromName, m.body])).toEqual([
			["claude-x", "hello pi"],
			["77", "raw text"],
		]);
	});

	it("reads a last line the sender did not terminate, and closes on half-close", async () => {
		const { t, messages } = await started();
		const s = connect({ path: t.socketPath as string });
		s.on("error", () => {});
		const closed = new Promise<void>((r) => s.on("close", () => r()));
		s.resume();
		await new Promise<void>((r) => s.on("connect", () => r()));
		s.end(frameFrom(join(root, "x.sock")).trimEnd());
		await closed;
		expect(messages.map((m) => m.body)).toEqual(["hello pi"]);
	});

	it("drops a connection that never sends a line", async () => {
		const { t } = await started();
		const s = connect({ path: t.socketPath as string });
		s.on("error", () => {});
		s.resume();
		const t0 = Date.now();
		await new Promise<void>((r) => s.on("close", () => r()));
		const waited = Date.now() - t0;
		expect(waited).toBeGreaterThan(1500);
		expect(waited).toBeLessThan(3000);
	});

	it("drops a connection whose line passes 1 MiB", async () => {
		const { t, messages } = await started();
		const s = connect({ path: t.socketPath as string });
		s.on("error", () => {});
		s.resume();
		const closed = new Promise<void>((r) => s.on("close", () => r()));
		s.write("x".repeat(1024 * 1024 + 1));
		await closed;
		expect(messages).toEqual([]);
	});

	it("drops a frame addressed to another session", async () => {
		const { t, messages } = await started();
		const sock = t.socketPath as string;
		await claudeSend(sock, frameFrom(join(root, "a.sock"), { session_id: "older-session" }, "stale"));
		await claudeSend(sock, frameFrom(join(root, "a.sock"), { session_id: SESSION }, "current"));
		expect(messages.map((m) => m.body)).toEqual(["current"]);
	});

	it("drops a repeated msg_id", async () => {
		const { t, messages } = await started();
		const line = frameFrom(join(root, "a.sock"));
		await claudeSend(t.socketPath as string, line + line);
		await claudeSend(t.socketPath as string, line);
		expect(messages).toHaveLength(1);
	});

	it("rate-limits a flooding sender without starving the others", async () => {
		const { t, messages } = await started();
		const flood = Array.from({ length: 40 }, () => frameFrom(join(root, "flood.sock"))).join("");
		await claudeSend(t.socketPath as string, flood + frameFrom(join(root, "quiet.sock")));
		expect(messages.filter((m) => m.from?.endsWith("flood.sock"))).toHaveLength(30);
		expect(messages.filter((m) => m.from?.endsWith("quiet.sock"))).toHaveLength(1);
	});

	it("ignores rename and the other control frames", async () => {
		const { t, messages, receipts } = await started();
		const sock = t.socketPath as string;
		await claudeSend(sock, `${JSON.stringify({ type: "control", action: "rename", name: "pwned" })}\n`);
		await claudeSend(sock, `${JSON.stringify({ type: "control", action: "notify_when_idle", from: "uds:/x", msg_id: "n" })}\n`);
		expect(messages).toEqual([]);
		expect(receipts).toEqual([]);
		expect(t.name).toBe("pi-my-repo");
	});
});

describe("receipts", () => {
	it("matches a receipt to what we sent, and reads a refusal", async () => {
		const claude = await fakeClaude(join(root, "socks", "4242.sock"));
		const { t, receipts } = await started();
		const [peer] = await t.peers();
		const { msgId } = await t.send(peer!, "hi");
		const status = (s: Record<string, unknown>) =>
			`${JSON.stringify({ type: "control", action: "peer_message_status", from: addressFor(claude.path), orig_msg_id: msgId, reason: "why", ...s })}\n`;
		await claudeSend(t.socketPath as string, status({ status: "held" }) + status({ status: "expired", status_detail: "refused" }));
		await claudeSend(t.socketPath as string, `${JSON.stringify({ type: "control", action: "peer_message_status", orig_msg_id: "unknown", status: "dropped", drop_reason: "rate-limited" })}\n`);
		expect(receipts).toEqual([
			{ origMsgId: msgId, status: "held", reason: "why", dropReason: undefined, from: addressFor(claude.path), sent: expect.objectContaining({ msgId }) },
			{ origMsgId: msgId, status: "refused", reason: "why", dropReason: undefined, from: addressFor(claude.path), sent: expect.objectContaining({ msgId }) },
			{ origMsgId: "unknown", status: "dropped", reason: undefined, dropReason: "rate-limited", from: undefined, sent: undefined },
		]);
	});
});
