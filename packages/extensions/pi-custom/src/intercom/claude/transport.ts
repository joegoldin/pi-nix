// A pi session as a Claude Code peer: registered in Claude's session registry
// so it shows up in ListAgents, listening on a socket Claude's SendMessage can
// reach, and able to send to Claude sessions the way they send to each other.
// No pi imports: the extension drives this through start, stop, the setters
// and send, and hears back through onMessage and onReceipt.
//
// Never sends a receipt. Claude renders a "delivered" receipt as "released
// after approval" even for a message that was never held, which costs the
// sender a confused extra turn, and pi has no approval step that would make
// held/denied/expired true.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildEnvelope, type FromMode, sanitizeName } from "./envelope.ts";
import { authLine, MAX_LINE, type Priority, readAuth, readFrame, type ReceiptStatus, userFrame } from "./frames.ts";
import { DuplicateWindow, RateLimiter, TtlMap } from "./guard.ts";
import {
	addressFor,
	claudeConfigDir,
	defaultSocketPath,
	derivedName,
	MAX_SOCKET_PATH_BYTES,
	sessionsDir,
	socketFromAddress,
	socketLabel,
} from "./paths.ts";
import {
	type Peer,
	matchedPidDomain,
	nameForSocket,
	procStart,
	readEntries,
	readPeers,
	readPeerToken,
	type RegistryEntry,
	removeFile,
	writeEntry,
	writeKey,
} from "./registry.ts";
import { claimPath, type Connection, type Listener, listen, prepareDir, probe, sendRaw } from "./socket.ts";

export type { Peer } from "./registry.ts";
export type { FromMode } from "./envelope.ts";
export type { Priority, ReceiptStatus } from "./frames.ts";

export type Status = "idle" | "busy";

export interface InboundMessage {
	msgId: string;
	/** The sender's socket path, decoded from its address; undefined if it gave none. */
	from?: string;
	/** The sender's "uds:" address, to reply to. */
	address?: string;
	/** The registry's name for the sender's socket, else the envelope's from-name, else the socket's basename. */
	fromName: string;
	fromSession?: string;
	fromMode?: FromMode;
	/** Whether the connection opened with the token we published. Not required on macOS or Linux. */
	authenticated: boolean;
	body: string;
	priority: Priority;
}

export interface SentRecord {
	msgId: string;
	address: string;
	socketPath: string;
	name?: string;
	sessionId?: string;
	sentAt: number;
}

export interface InboundReceipt {
	origMsgId: string;
	status: ReceiptStatus;
	reason?: string;
	dropReason?: string;
	/** The address the receipt came from. */
	from?: string;
	/** What we sent under origMsgId, while it is still remembered. */
	sent?: SentRecord;
}

export type SendTarget = string | Pick<Peer, "socketPath"> & Partial<Pick<Peer, "sessionId" | "name">>;

export interface ClaudeTransportOptions {
	/** Claude's config home. Default: $CLAUDE_CONFIG_DIR, else ~/.claude. */
	configDir?: string;
	/** Environment for the default socket location (XDG_RUNTIME_DIR). Default: process.env. */
	env?: Record<string, string | undefined>;
	/** Our socket, bypassing discovery. */
	socketPath?: string;
	pid?: number;
	uid?: number;
	onMessage?: (message: InboundMessage) => void;
	onReceipt?: (receipt: InboundReceipt) => void;
	/** Diagnostics: drops and failures. Default: silent. */
	log?: (text: string) => void;
	now?: () => number;
}

export interface Registration {
	sessionId: string;
	cwd: string;
	/** The pi session's name; without one the entry is named pi-<dir>. */
	name?: string;
}

interface Endpoint {
	listener: Listener;
	socketPath: string;
	address: string;
	token: string;
	entryPath: string;
	keyPath: string;
}

export class ClaudeTransport {
	readonly configDir: string;
	readonly registryDir: string;
	private readonly pid: number;
	private readonly uid: number;
	private readonly now: () => number;
	private readonly log: (text: string) => void;
	private readonly limiter: RateLimiter;
	private readonly duplicates: DuplicateWindow;
	private readonly sent: TtlMap<SentRecord>;
	private endpoint?: Endpoint;
	private entry?: RegistryEntry;
	private readonly onExit = () => this.cleanupSync();

	constructor(private readonly opts: ClaudeTransportOptions = {}) {
		this.configDir = opts.configDir ?? claudeConfigDir(opts.env ?? process.env);
		this.registryDir = sessionsDir(this.configDir);
		this.pid = opts.pid ?? process.pid;
		this.uid = opts.uid ?? process.getuid?.() ?? 0;
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => {});
		this.limiter = new RateLimiter(this.now);
		this.duplicates = new DuplicateWindow(this.now);
		this.sent = new TtlMap<SentRecord>(this.now);
	}

	get running(): boolean {
		return this.endpoint !== undefined;
	}

	get socketPath(): string | undefined {
		return this.endpoint?.socketPath;
	}

	get address(): string | undefined {
		return this.endpoint?.address;
	}

	get name(): string | undefined {
		return this.entry?.name;
	}

	/** Binds our socket and registers us. Throws when there is no safe place for the socket. */
	async start(reg: Registration): Promise<void> {
		if (this.endpoint) throw new Error("Claude transport already started");
		// Claude's directory as much as ours: create it if missing, never re-mode it.
		mkdirSync(this.registryDir, { recursive: true, mode: 0o700 });
		const socketPath = await claimPath(await this.chooseSocketPath());
		const listener = await listen(socketPath, () => this.connection());
		const token = randomBytes(16).toString("hex");
		const started = this.now();
		const pidStart = procStart(this.pid);
		const pidDomain = pidStart ? matchedPidDomain(readEntries(this.registryDir), this.pid) : undefined;
		const name = reg.name === undefined ? "" : sanitizeName(reg.name);
		this.entry = {
			pid: this.pid,
			sessionId: reg.sessionId,
			cwd: reg.cwd,
			startedAt: started,
			...(pidStart && { procStart: pidStart }),
			...(pidDomain && { pidDomain }),
			version: "pi-custom",
			peerProtocol: 1,
			peerFeatures: [],
			kind: "interactive",
			entrypoint: "pi",
			messagingSocketPath: socketPath,
			name: name || derivedName(reg.cwd),
			nameSource: name ? "user" : "derived",
			nameSince: started,
			status: "idle",
			updatedAt: started,
			statusUpdatedAt: started,
		};
		this.endpoint = { listener, socketPath, address: addressFor(socketPath), token, entryPath: "", keyPath: "" };
		process.on("exit", this.onExit);
		try {
			this.endpoint.keyPath = writeKey(this.registryDir, this.pid, socketPath, {
				peerToken: token,
				...(pidStart && { procStart: pidStart }),
				...(pidDomain && { pidDomain }),
			});
			this.endpoint.entryPath = writeEntry(this.registryDir, this.entry);
		} catch (err) {
			await this.stop();
			throw err;
		}
	}

	/** Unregisters and closes the socket. Safe to call twice. */
	async stop(): Promise<void> {
		const ep = this.endpoint;
		if (!ep) return;
		process.off("exit", this.onExit);
		this.cleanupSync();
		await ep.listener.close();
	}

	/** Renames us in the registry. No name means pi-<dir> again. */
	setName(name?: string): void {
		if (!this.entry) return;
		const clean = name === undefined ? "" : sanitizeName(name);
		const next = clean || derivedName(this.entry.cwd ?? "");
		const source = clean ? "user" : "derived";
		if (next === this.entry.name && source === this.entry.nameSource) return;
		const now = this.now();
		this.patch({ name: next, nameSource: source, nameSince: now, updatedAt: now });
	}

	setStatus(status: Status): void {
		if (!this.entry || this.entry.status === status) return;
		const now = this.now();
		this.patch({ status, statusUpdatedAt: now, updatedAt: now });
	}

	/** Re-registers under a new pi session, as after /new or /resume; frames for the old one are then refused. */
	setSession(reg: Registration): void {
		if (!this.entry) return;
		const now = this.now();
		this.patch({ sessionId: reg.sessionId, cwd: reg.cwd, startedAt: now, updatedAt: now });
		this.setName(reg.name);
	}

	/** Every other session in Claude's registry, live or not. */
	peers(): Promise<Peer[]> {
		return readPeers(this.registryDir, this.pid, addressFor);
	}

	/**
	 * Sends body to a Claude session (or a pi session using this transport),
	 * resolving once the receiver has closed the connection. Receipts for it
	 * arrive later through onReceipt, matched by msgId.
	 */
	async send(target: SendTarget, body: string, opts: { fromName?: string; fromMode?: FromMode } = {}): Promise<{ msgId: string }> {
		const ep = this.endpoint;
		if (!ep) throw new Error("Claude transport is not started");
		const socketPath = typeof target === "string" ? socketFromAddress(target) : target.socketPath;
		if (!socketPath) throw new Error(`Not a Claude peer address: ${String(target)}`);
		const sessionId = typeof target === "string" ? undefined : target.sessionId;
		const msgId = randomUUID();
		const content = buildEnvelope(
			{ from: ep.address, fromName: opts.fromName ?? this.entry?.name, fromMode: opts.fromMode ?? "prompting" },
			body,
		);
		const token = readPeerToken(this.registryDir, socketPath);
		const data = `${token ? authLine(token) : ""}${JSON.stringify(userFrame({ msgId, from: ep.address, content, sessionId }))}\n`;
		if (Buffer.byteLength(data) > MAX_LINE) throw new Error(`Message too large to send to a Claude session (over ${MAX_LINE} bytes)`);
		// Recorded before sending: a "held" receipt can arrive before our send resolves.
		this.sent.set(msgId, {
			msgId,
			address: addressFor(socketPath),
			socketPath,
			name: typeof target === "string" ? undefined : target.name,
			sessionId,
			sentAt: this.now(),
		});
		try {
			await sendRaw(socketPath, data);
		} catch (err) {
			this.sent.delete(msgId);
			throw err;
		}
		return { msgId };
	}

	/** What was sent under msgId, while it is still remembered. */
	sentRecord(msgId: string): SentRecord | undefined {
		return this.sent.get(msgId);
	}

	/** Everything sent recently, oldest first. */
	recentSends(): SentRecord[] {
		return this.sent.values();
	}

	private patch(fields: Partial<RegistryEntry>): void {
		if (!this.entry) return;
		this.entry = { ...this.entry, ...fields };
		try {
			writeEntry(this.registryDir, this.entry);
		} catch (err) {
			this.log(`claude registry write failed: ${(err as Error).message}`);
		}
	}

	private cleanupSync(): void {
		const ep = this.endpoint;
		if (!ep) return;
		this.endpoint = undefined;
		this.entry = undefined;
		if (ep.entryPath) removeFile(ep.entryPath);
		if (ep.keyPath) removeFile(ep.keyPath);
		removeFile(ep.socketPath);
	}

	/**
	 * Our socket goes next to a live Claude session's when there is one, so
	 * Claude's check that a reply address is a sibling of its own socket passes
	 * and its receipts reach us. Otherwise it goes where Claude would put it.
	 */
	private async chooseSocketPath(): Promise<string> {
		if (this.opts.socketPath) {
			prepareDir(dirname(this.opts.socketPath), this.uid);
			return this.opts.socketPath;
		}
		const fallback = defaultSocketPath(this.pid, this.uid, this.opts.env ?? process.env);
		const claude = readEntries(this.registryDir)
			.filter((e) => e.pid !== this.pid && e.entrypoint !== "pi" && e.messagingSocketPath?.endsWith(".sock"))
			.map((e) => e.messagingSocketPath as string);
		const live = (await Promise.all(claude.map(async (p) => ((await probe(p, 250)) ? p : undefined)))).filter(
			(p): p is string => p !== undefined,
		);
		const dirs = [...new Set(live.map((p) => dirname(p)))];
		const candidates = dirs.includes(dirname(fallback)) ? [] : dirs.map((d) => join(d, `${this.pid}.sock`));
		for (const path of candidates) {
			if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) continue;
			try {
				prepareDir(dirname(path), this.uid);
				return path;
			} catch (err) {
				this.log(`not using ${dirname(path)} for our socket: ${(err as Error).message}`);
			}
		}
		prepareDir(dirname(fallback), this.uid);
		return fallback;
	}

	private connection(): Connection {
		let first = true;
		let authenticated = false;
		return {
			line: (text) => {
				if (first) {
					first = false;
					const token = readAuth(text);
					if (token !== undefined) {
						authenticated = this.tokenMatches(token);
						return;
					}
				}
				this.handle(text, authenticated);
			},
		};
	}

	private tokenMatches(token: string): boolean {
		const ours = this.endpoint?.token;
		if (!ours || token.length !== ours.length) return false;
		return timingSafeEqual(Buffer.from(token), Buffer.from(ours));
	}

	private handle(text: string, authenticated: boolean): void {
		const frame = readFrame(text, this.entry?.sessionId ?? "");
		if (frame.kind === "ignored") {
			if (frame.reason !== "unhandled") this.log(`claude peer frame dropped: ${frame.reason}`);
			return;
		}
		if (frame.kind === "receipt") {
			const { kind: _kind, address, ...receipt } = frame;
			this.opts.onReceipt?.({ ...receipt, from: address, sent: this.sent.get(frame.origMsgId) });
			return;
		}
		if (frame.msgId && this.duplicates.seen(frame.msgId)) {
			this.log(`claude peer message dropped: duplicate ${frame.msgId}`);
			return;
		}
		const sender = frame.address ?? "unknown";
		if (!this.limiter.take(sender)) {
			this.log(`claude peer message dropped: rate limit for ${sender}`);
			return;
		}
		const from = frame.address ? socketFromAddress(frame.address) : undefined;
		this.opts.onMessage?.({
			msgId: frame.msgId ?? randomUUID(),
			from,
			address: frame.address,
			fromName: (from && nameForSocket(this.registryDir, from)) || frame.fromName || (from && socketLabel(from)) || "peer",
			fromSession: frame.fromSession,
			fromMode: frame.fromMode,
			authenticated,
			body: frame.body,
			priority: frame.priority,
		});
	}
}
