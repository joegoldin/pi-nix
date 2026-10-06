// Runs the real broker.ts under bun against a temp agent dir and drives it with
// IntercomClient and with raw frames where a test needs to say something the
// client never would.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { IntercomClient } from "./client.ts";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerSocketPath } from "./paths.ts";
import { BROKER_PATH, checkSocketConnectable } from "./spawn.ts";
import type { Message, MessageControl, MessageReceipt, SessionInfo, SessionRegistration } from "./types.ts";

let agentDir: string;
let broker: ChildProcess;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const clients: IntercomClient[] = [];

async function startBroker(dir: string): Promise<ChildProcess> {
	const child = spawn(process.execPath, [BROKER_PATH], {
		env: { ...process.env, PI_CODING_AGENT_DIR: dir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Broker startup timed out")), 10_000);
		child.stdout!.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("Intercom broker started")) {
				clearTimeout(timeout);
				resolve();
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Broker exited before startup (${code})`));
		});
	});
	return child;
}

beforeAll(async () => {
	agentDir = mkdtempSync("/tmp/pib-");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	broker = await startBroker(agentDir);
});

afterAll(async () => {
	await Promise.all(clients.map((client) => client.disconnect().catch(() => {})));
	if (broker.exitCode === null) {
		broker.kill("SIGTERM");
		await once(broker, "exit");
	}
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

function registration(name: string | undefined, cwd = "/work/a"): SessionRegistration {
	return { ...(name ? { name } : {}), cwd, model: "test-model", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() };
}

interface Peer {
	client: IntercomClient;
	id: string;
	messages: Array<{ from: SessionInfo; message: Message }>;
	receipts: MessageReceipt[];
	controls: MessageControl[];
	errors: Error[];
}

async function connect(name: string | undefined, options: { id?: string; cwd?: string; scope?: string } = {}): Promise<Peer> {
	const client = new IntercomClient();
	const peer: Peer = { client, id: "", messages: [], receipts: [], controls: [], errors: [] };
	client.on("message", (from: SessionInfo, message: Message) => peer.messages.push({ from, message }));
	client.on("message_receipt", (_from: SessionInfo, receipt: MessageReceipt) => peer.receipts.push(receipt));
	client.on("message_control", (_from: SessionInfo, control: MessageControl) => peer.controls.push(control));
	client.on("error", (error: Error) => peer.errors.push(error));
	const previousScope = process.env.PI_INTERCOM_SCOPE_ID;
	if (options.scope) process.env.PI_INTERCOM_SCOPE_ID = options.scope;
	try {
		await client.connect(registration(name, options.cwd), options.id ?? unique("id"));
	} finally {
		if (previousScope === undefined) delete process.env.PI_INTERCOM_SCOPE_ID;
		else process.env.PI_INTERCOM_SCOPE_ID = previousScope;
	}
	clients.push(client);
	peer.id = client.sessionId!;
	return peer;
}

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 3000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** A raw connection for frames IntercomClient would never send. */
async function rawPeer() {
	const socket = net.connect(getBrokerSocketPath());
	socket.on("error", () => {});
	const frames: Array<Record<string, unknown>> = [];
	socket.on("data", createMessageReader((msg) => frames.push(msg as Record<string, unknown>), () => {}));
	await once(socket, "connect");
	const closed = once(socket, "close");
	return {
		socket,
		frames,
		closed,
		write: (msg: unknown) => writeMessage(socket, msg),
		next: (type: string, match: (frame: Record<string, unknown>) => boolean = () => true) =>
			until(() => frames.find((frame) => frame.type === type && match(frame)), `${type} frame`),
	};
}

async function rawRegistered(name: string, id = unique("raw")) {
	const raw = await rawPeer();
	raw.write({ type: "register", session: registration(name), sessionId: id });
	await raw.next("registered");
	return raw;
}

const rawMessage = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, timestamp: Date.now(), content: { text }, ...extra });

describe("roster", () => {
	it("registers, advertises exact-send only, lists, and announces joins and leaves", async () => {
		const a = await connect(unique("alpha"));
		expect(a.client.supportsFeature("exact-send-v1")).toBe(true);
		expect(a.client.supportsFeature("extension-bus-v1")).toBe(false);
		const joined: SessionInfo[] = [];
		const left: string[] = [];
		a.client.on("session_joined", (session: SessionInfo) => joined.push(session));
		a.client.on("session_left", (id: string) => left.push(id));

		const b = await connect(unique("beta"), { cwd: "/work/b" });
		const listed = await a.client.listSessions();
		const bInfo = listed.find((s) => s.id === b.id)!;
		expect(bInfo.cwd).toBe("/work/b");
		expect(bInfo.trustedLocal).toBe(true);
		expect(bInfo.endpointEpoch).toBeString();
		await until(() => joined.find((s) => s.id === b.id), "session_joined");

		await b.client.disconnect();
		await until(() => left.find((id) => id === b.id), "session_left");
		expect((await a.client.listSessions()).some((s) => s.id === b.id)).toBe(false);
	});

	it("isolates scopes, including sessions that share an id", async () => {
		const id = unique("shared");
		const red = await connect(unique("red"), { id, scope: "red" });
		const blue = await connect(unique("blue"), { id, scope: "blue" });
		const redList = await red.client.listSessions();
		expect(redList.filter((s) => s.id === id)).toHaveLength(1);
		const blueName = (await blue.client.listSessions()).find((s) => s.id === id)!.name!;
		const result = await red.client.send(blueName, { text: "across scopes" });
		expect(result.delivered).toBe(false);
		expect(result.code).toBe("E_TARGET_NOT_FOUND");
	});

	it("broadcasts presence, with null clearing a context field", async () => {
		const watcher = await connect(unique("watcher"));
		const updates: SessionInfo[] = [];
		watcher.client.on("presence_update", (session: SessionInfo) => updates.push(session));
		const busy = await connect(unique("busy"));
		busy.client.updatePresence({ status: "thinking", contextPct: 42, contextTokens: 4200, contextWindow: 10_000 });
		const first = await until(() => updates.find((s) => s.id === busy.id && s.status === "thinking"), "presence");
		expect(first.contextPct).toBe(42);
		busy.client.updatePresence({ status: "idle", contextPct: null });
		const second = await until(() => updates.find((s) => s.id === busy.id && s.status === "idle"), "cleared presence");
		expect(second.contextPct).toBeUndefined();
		expect(second.contextTokens).toBe(4200);
	});
});

describe("sending", () => {
	it("delivers by name, id prefix and id, and routes receipts back to the sender only", async () => {
		const sender = await connect(unique("sender"));
		const receiverName = unique("receiver");
		const receiver = await connect(receiverName);

		const byName = await sender.client.send(receiverName.toUpperCase(), { text: "by name" });
		expect(byName).toMatchObject({ delivered: true, delivery: "socket_delivered", outcomeKnown: true });
		const byPrefix = await sender.client.send(receiver.id.slice(0, 12), { text: "by prefix" });
		expect(byPrefix.delivered).toBe(true);
		await until(() => (receiver.messages.length === 2 ? true : undefined), "two messages");
		const [first] = receiver.messages;
		expect(first!.from.id).toBe(sender.id);
		expect(first!.message.content.text).toBe("by name");
		expect(first!.message.brokerReceivedAt).toBeNumber();
		expect(first!.message.senderSequence).toBe(1);

		receiver.client.sendMessageReceipt({ messageId: first!.message.id, status: "injected", timestamp: Date.now() });
		await until(() => sender.receipts.find((r) => r.status === "injected"), "receipt");

		// A session the message was not routed to cannot report on it.
		const bystander = await connect(unique("bystander"));
		bystander.client.sendMessageReceipt({ messageId: first!.message.id, status: "expired", timestamp: Date.now() });
		await settle();
		expect(sender.receipts.some((r) => r.status === "expired")).toBe(false);
	});

	it("refuses an ambiguous name and an unknown target", async () => {
		const sender = await connect(unique("sender"));
		const twin = unique("twin");
		await connect(twin, { cwd: "/work/x" });
		await connect(twin, { cwd: "/work/y" });
		expect((await sender.client.send(twin, { text: "which?" })).code).toBe("E_AMBIGUOUS_TARGET");
		expect((await sender.client.send(unique("nobody"), { text: "hello?" })).code).toBe("E_TARGET_NOT_FOUND");
	});

	it("tells the receiver about supersede and cancel", async () => {
		const sender = await connect(unique("sender"));
		const receiver = await connect(unique("receiver"));
		const first = await sender.client.send(receiver.id, { text: "v1" });
		await sender.client.send(receiver.id, { text: "v2", supersedes: first.id });
		await until(() => receiver.controls.find((c) => c.action === "supersede" && c.messageId === first.id), "supersede control");
		const third = await sender.client.send(receiver.id, { text: "v3" });
		expect((await sender.client.cancelMessage(third.id)).delivered).toBe(true);
		await until(() => receiver.controls.find((c) => c.action === "cancel" && c.messageId === third.id), "cancel control");

		const other = await connect(unique("other"));
		const notMine = await other.client.cancelMessage(third.id);
		expect(notMine.delivered).toBe(false);
		expect((await other.client.send(receiver.id, { text: "x", supersedes: third.id })).code).toBe("E_SUPERSEDE_TARGET");
	});

	it("reports a rebound endpoint, accepts the retry, and replays or refuses a reused id", async () => {
		const targetId = unique("target");
		const first = await connect(unique("target-name"), { id: targetId });
		const oldEpoch = (await first.client.listSessions()).find((s) => s.id === targetId)!.endpointEpoch!;
		await first.client.disconnect();
		const second = await connect(unique("target-name"), { id: targetId });

		const raw = await rawRegistered(unique("raw-sender"));
		const message = rawMessage(unique("m"), "exact");
		raw.write({ type: "send", to: targetId, message, targetId, targetEpoch: oldEpoch });
		const rebound = await raw.next("delivery_failed", (f) => f.messageId === message.id);
		expect(rebound).toMatchObject({ code: "E_TARGET_REBOUND", retryable: true });

		const newEpoch = (await second.client.listSessions()).find((s) => s.id === targetId)!.endpointEpoch!;
		raw.write({ type: "send", to: targetId, message, targetId, targetEpoch: newEpoch });
		await raw.next("delivered", (f) => f.messageId === message.id);
		await until(() => second.messages.find((m) => m.message.id === message.id), "rebound retry");

		// Same id and content: the earlier outcome, not a second delivery.
		raw.frames.length = 0;
		raw.write({ type: "send", to: targetId, message });
		await raw.next("delivered", (f) => f.messageId === message.id);
		await settle();
		expect(second.messages.filter((m) => m.message.id === message.id)).toHaveLength(1);

		raw.write({ type: "send", to: targetId, message: { ...message, content: { text: "changed" } } });
		expect(await raw.next("delivery_failed", (f) => f.messageId === message.id)).toMatchObject({ code: "E_MESSAGE_ID_REUSE" });
		raw.socket.destroy();
	});

	it("queues mail for a named session that left and delivers it when it returns", async () => {
		const sender = await connect(unique("sender"));
		const name = unique("mailbox");
		const id = unique("mailbox-id");
		const away = await connect(name, { id, cwd: "/work/mail" });
		await away.client.disconnect();

		const queued = await sender.client.send(name, { text: "while you were out" });
		expect(queued).toMatchObject({ delivered: true, delivery: "queued" });
		const cancelled = await sender.client.send(name, { text: "never mind" });
		expect((await sender.client.cancelMessage(cancelled.id)).delivered).toBe(true);
		const ask = await sender.client.send(name, { text: "are you there?", expectsReply: true });
		expect(ask.code).toBe("E_TARGET_DISCONNECTED");

		const back = await connect(name, { id, cwd: "/work/mail" });
		await until(() => back.messages.find((m) => m.message.id === queued.id), "queued message");
		await settle();
		expect(back.messages.some((m) => m.message.id === cancelled.id)).toBe(false);
	});
});

describe("asks", () => {
	it("routes a reply along the ask edge and refuses replies that do not match it", async () => {
		const asker = await connect(unique("asker"));
		const target = await connect(unique("target"));
		const bystander = await connect(unique("bystander"));

		const ask = await asker.client.send(target.id, { text: "question?", expectsReply: true });
		expect(ask.delivered).toBe(true);
		await until(() => target.messages.find((m) => m.message.id === ask.id && m.message.expectsReply), "ask");

		expect((await bystander.client.send(asker.id, { text: "not you", replyTo: ask.id })).code).toBe("E_REPLY_TARGET");
		const reply = await target.client.send(asker.id, { text: "answer", replyTo: ask.id });
		expect(reply.delivered).toBe(true);
		await until(() => asker.messages.find((m) => m.message.replyTo === ask.id), "reply");
		// The edge is spent once answered.
		expect((await target.client.send(asker.id, { text: "again", replyTo: ask.id })).code).toBe("E_REPLY_TARGET");
	});

	it("refuses a mutual ask, and allows it again after cancel_ask", async () => {
		const a = await connect(unique("a"));
		const b = await connect(unique("b"));
		const ask = await a.client.send(b.id, { text: "a asks b", expectsReply: true });
		expect((await b.client.send(a.id, { text: "b asks a", expectsReply: true })).code).toBe("E_MUTUAL_ASK");
		a.client.cancelAsk(ask.id);
		await settle();
		expect((await b.client.send(a.id, { text: "b asks a", expectsReply: true })).delivered).toBe(true);
	});

	// D2.3: upstream never cleared ask edges on disconnect, so an asker that
	// crashed and came back under the same id was refused E_MUTUAL_ASK by the
	// peer it had asked until the old ask timed out (10 min by default).
	it("drops a session's ask edges when it disconnects", async () => {
		const askerId = unique("asker-id");
		const asker = await connect(unique("asker"), { id: askerId });
		const target = await connect(unique("target"));
		await asker.client.send(target.id, { text: "question?", expectsReply: true });
		await asker.client.disconnect();
		await connect(unique("asker"), { id: askerId });
		const askBack = await target.client.send(askerId, { text: "my own question", expectsReply: true });
		expect(askBack.code).toBeUndefined();
		expect(askBack.delivered).toBe(true);
	});

	it("keeps asks made of a target that drops, so it can answer after reconnecting", async () => {
		const asker = await connect(unique("asker"));
		const targetId = unique("target-id");
		const target = await connect(unique("target"), { id: targetId });
		const ask = await asker.client.send(targetId, { text: "question?", expectsReply: true });
		await target.client.disconnect();
		const back = await connect(unique("target"), { id: targetId });
		// The asker is still waiting, so asking it back would deadlock.
		expect((await back.client.send(asker.id, { text: "my own question", expectsReply: true })).code).toBe("E_MUTUAL_ASK");
		expect((await back.client.send(asker.id, { text: "late answer", replyTo: ask.id })).delivered).toBe(true);
	});
});

describe("identity", () => {
	// D2.2: upstream evicted the live holder of a claimed id and gave the
	// newcomer its identity and mailbox. The id is no secret (list shows it).
	it("refuses a register that claims a live session's id and keeps the original", async () => {
		const id = unique("held");
		const original = await connect(unique("original"), { id });
		const epoch = (await original.client.listSessions()).find((s) => s.id === id)!.endpointEpoch;

		const impostor = new IntercomClient();
		const error = await impostor.connect(registration("impostor"), id).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Session ID already held by a live session");
		expect(impostor.isConnected()).toBe(false);

		expect(original.client.isConnected()).toBe(true);
		const listed = (await original.client.listSessions()).filter((s) => s.id === id);
		expect(listed).toHaveLength(1);
		expect(listed[0]!.endpointEpoch).toBe(epoch);
		expect(listed[0]!.name).not.toBe("impostor");
		const sender = await connect(unique("sender"));
		await sender.client.send(id, { text: "still yours" });
		await until(() => original.messages.find((m) => m.message.content.text === "still yours"), "message to original");

		// Once the holder has gone, the id is free to reclaim.
		await original.client.disconnect();
		const reclaimed = await connect(unique("reclaimed"), { id });
		expect(reclaimed.id).toBe(id);
	});
});

describe("dropped upstream features", () => {
	it("rejects extension-bus frames as E_INVALID_MESSAGE and keeps the connection", async () => {
		const raw = await rawRegistered(unique("raw"));
		for (const type of ["extension_capabilities_update", "extension_publish", "extension_state_commit"]) {
			raw.write({ type, namespace: "test/v1", audience: "capable", payload: {} });
			const error = await raw.next("error", (f) => String(f.error).includes(type));
			expect(String(error.error)).toStartWith("E_INVALID_MESSAGE:");
		}
		raw.write({ type: "list", requestId: "still-here" });
		await raw.next("sessions", (f) => f.requestId === "still-here");
		raw.socket.destroy();
	});

	it("refuses messages carrying outbox provenance or cross-machine origin", async () => {
		const receiver = await connect(unique("receiver"));
		const raw = await rawRegistered(unique("raw"));
		const withProvenance = rawMessage(unique("m"), "x", {
			provenance: { type: "extension_outbox", extensionId: "e", extensionName: "e", requestId: "r" },
		} as Partial<Message>);
		raw.write({ type: "send", to: receiver.id, message: withProvenance });
		expect(await raw.next("delivery_failed", (f) => f.messageId === withProvenance.id)).toMatchObject({ code: "E_INVALID_MESSAGE" });
		const relayed = rawMessage(unique("m"), "x", {
			crossMachine: { type: "ssh-relay", version: 1, origin: { name: "n", sessionId: "s", machine: "m" }, trust: "ssh-asserted" },
		} as Partial<Message>);
		raw.write({ type: "send", to: receiver.id, message: relayed });
		expect(await raw.next("delivery_failed", (f) => f.messageId === relayed.id)).toMatchObject({ code: "E_INVALID_MESSAGE" });
		await settle();
		expect(receiver.messages).toHaveLength(0);
		raw.socket.destroy();
	});
});

describe("robustness", () => {
	it("closes a connection that speaks before registering", async () => {
		const raw = await rawPeer();
		raw.write({ type: "list", requestId: "early" });
		await raw.closed;
		expect(raw.frames).toHaveLength(0);
	});

	it("answers health without registration", async () => {
		expect(await checkSocketConnectable()).toBe(true);
	});

	it("survives clients that vanish mid-frame or right after registering", async () => {
		const partial = await rawPeer();
		const header = Buffer.alloc(4);
		header.writeUInt32BE(100, 0);
		partial.socket.write(Buffer.concat([header, Buffer.from('{"type":"reg')]));
		partial.socket.destroy();
		const registered = await rawRegistered(unique("vanishing"));
		registered.write({ type: "send", to: "nobody", message: rawMessage("m", "x") });
		registered.socket.destroy();
		await settle();
		expect(broker.exitCode).toBeNull();
		expect(await checkSocketConnectable()).toBe(true);
	});
});

describe("lifecycle", () => {
	it("shuts down 5 s after the last session leaves and removes its socket and pid", async () => {
		const dir = mkdtempSync("/tmp/pib-");
		const own = await startBroker(dir);
		try {
			process.env.PI_CODING_AGENT_DIR = dir;
			const client = new IntercomClient();
			await client.connect(registration("short-lived"), "short-lived");
			await client.disconnect();
			const [code] = await Promise.race([
				once(own, "exit"),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("broker did not exit")), 8000)),
			]);
			expect(code).toBe(0);
			expect(await checkSocketConnectable(getBrokerSocketPath(dir))).toBe(false);
		} finally {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			if (own.exitCode === null) own.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);
});
