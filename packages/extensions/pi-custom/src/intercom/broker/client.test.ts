import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import { IntercomClient } from "./client.ts";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerSocketPath, getIntercomDirPath } from "./paths.ts";
import type { BrokerMessage, Message, SessionInfo } from "./types.ts";

const peer: SessionInfo = { id: "session-2", cwd: "/test", model: "test", pid: 2, startedAt: 1, lastActivity: 1 };

// handleBrokerMessage is private; these tests drive it directly, as upstream's do.
const handle = (client: IntercomClient, msg: unknown) => (client as unknown as { handleBrokerMessage(m: unknown): void }).handleBrokerMessage(msg);

function registeredClient(): IntercomClient {
	const client = new IntercomClient();
	(client as unknown as { _sessionId: string })._sessionId = "session-1";
	return client;
}

describe("broker frames", () => {
	it("passes validated roster events to broker-message subscribers", () => {
		const client = registeredClient();
		const received: BrokerMessage[] = [];
		client.onBrokerMessage((message) => received.push(message));
		handle(client, { type: "session_joined", session: peer });
		handle(client, { type: "presence_update", session: peer });
		handle(client, { type: "session_left", sessionId: "session-2" });
		expect(received).toEqual([
			{ type: "session_joined", session: peer },
			{ type: "presence_update", session: peer },
			{ type: "session_left", sessionId: "session-2" },
		]);
	});

	it("rejects non-string feature entries in registered", () => {
		expect(() => handle(new IntercomClient(), { type: "registered", sessionId: "s", features: ["ok", 123] })).toThrow(
			"Invalid registered features",
		);
	});

	it("turns an error before registration into a failed connect", () => {
		expect(() => handle(new IntercomClient(), { type: "error", error: "Session ID already held by a live session" })).toThrow(
			"Session ID already held by a live session",
		);
	});

	it("treats extension-bus frames as unknown, since it never advertises the bus", () => {
		expect(() => handle(registeredClient(), { type: "extension_owner", namespace: "test/v1" })).toThrow(
			"Unknown broker message type: extension_owner",
		);
	});

	it("strips upstream outbox provenance and cross-machine origin from inbound messages", () => {
		const client = registeredClient();
		const got: Message[] = [];
		client.on("message", (_from: SessionInfo, message: Message) => got.push(message));
		handle(client, {
			type: "message",
			from: peer,
			message: {
				id: "m1",
				timestamp: 1,
				content: { text: "hi" },
				provenance: { type: "extension_outbox", extensionId: "x", extensionName: "x", requestId: "r" },
				crossMachine: { type: "ssh-relay", version: 1, origin: { name: "n", sessionId: "s", machine: "m" }, trust: "ssh-asserted" },
			},
		});
		expect(got).toEqual([{ id: "m1", timestamp: 1, content: { text: "hi" } }]);
	});

	it("does not throw a broker error at nobody", () => {
		expect(() => handle(registeredClient(), { type: "error", error: "E_INVALID_MESSAGE: x" })).not.toThrow();
		const client = registeredClient();
		const errors: Error[] = [];
		client.on("error", (error: Error) => errors.push(error));
		handle(client, { type: "error", error: "E_INVALID_MESSAGE: x" });
		expect(errors.map((e) => e.message)).toEqual(["E_INVALID_MESSAGE: x"]);
	});

	it("ignores a synchronous write failure in cancelAsk", () => {
		const client = registeredClient();
		(client as unknown as { socket: unknown }).socket = {
			destroyed: false,
			writableEnded: false,
			writable: true,
			write() {
				throw new Error("write failed");
			},
		};
		expect(() => client.cancelAsk("ask-1")).not.toThrow();
	});
});

// A fake broker on the real socket path, so the client's socket handling can be
// driven into the failures a real broker produces only when killed.
describe("connection liveness", () => {
	let agentDir: string;
	const previous = {
		dir: process.env.PI_CODING_AGENT_DIR,
		interval: process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS,
		timeout: process.env.PI_INTERCOM_LIVENESS_TIMEOUT_MS,
	};
	const restore = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};

	beforeAll(() => {
		agentDir = mkdtempSync("/tmp/pic-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS = "100";
		process.env.PI_INTERCOM_LIVENESS_TIMEOUT_MS = "200";
	});

	afterAll(() => {
		restore("PI_CODING_AGENT_DIR", previous.dir);
		restore("PI_INTERCOM_LIVENESS_INTERVAL_MS", previous.interval);
		restore("PI_INTERCOM_LIVENESS_TIMEOUT_MS", previous.timeout);
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function connectToFakeBroker() {
		const socketPath = getBrokerSocketPath();
		mkdirSync(getIntercomDirPath(), { recursive: true });
		try {
			unlinkSync(socketPath);
		} catch {
			// No stale socket.
		}
		let responding = true;
		let serverSide!: net.Socket;
		const server = net.createServer((socket) => {
			serverSide = socket;
			socket.on("error", () => {});
			socket.on(
				"data",
				createMessageReader(
					(msg) => {
						if (!responding) return;
						const frame = msg as { type: string; sessionId?: string; requestId?: string };
						if (frame.type === "register") writeMessage(socket, { type: "registered", sessionId: frame.sessionId ?? "x", features: [] });
						if (frame.type === "list") writeMessage(socket, { type: "sessions", requestId: frame.requestId, sessions: [] });
					},
					() => {},
				),
			);
			server.close();
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		const client = new IntercomClient();
		await client.connect({ name: "liveness", cwd: agentDir, model: "m", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() }, "liveness-id");
		const clientSocket = (client as unknown as { socket: net.Socket }).socket;
		return { client, clientSocket, serverSide: () => serverSide, stopResponding: () => (responding = false) };
	}

	const within = <T>(promise: Promise<T>, ms: number, what: string) =>
		Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(what)), ms))]);

	it("emits disconnected when the broker drops the socket without a FIN", async () => {
		const { client, serverSide } = await connectToFakeBroker();
		expect(client.isConnected()).toBe(true);
		const disconnected = once(client, "disconnected");
		serverSide().destroy();
		await within(disconnected, 3000, "client never noticed the dropped socket");
		expect(client.isConnected()).toBe(false);
	});

	it("detects a half-open socket with the heartbeat", async () => {
		const { client, stopResponding } = await connectToFakeBroker();
		const disconnected = once(client, "disconnected");
		stopResponding();
		const [error] = (await within(disconnected, 3000, "heartbeat never detected the half-open socket")) as [Error];
		expect(error.message).toBe("List sessions timeout");
		expect(client.isConnected()).toBe(false);
	});

	// D2.4: upstream's cleanup removed every 'error' listener, so a reset that
	// arrived after close was an unhandled 'error' event and crashed pi.
	it("survives a socket error that arrives after the connection closed", async () => {
		const { client, clientSocket, serverSide } = await connectToFakeBroker();
		const disconnected = once(client, "disconnected");
		serverSide().destroy();
		await disconnected;
		expect(() => clientSocket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).not.toThrow();
	});

	it("survives a socket error that arrives after disconnect()", async () => {
		const { client, clientSocket } = await connectToFakeBroker();
		await client.disconnect();
		expect(client.isConnected()).toBe(false);
		expect(() => clientSocket.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
	});
});
