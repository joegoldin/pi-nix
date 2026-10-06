// Two runtimes over a real broker, with pi faked: the inbox policy, ask and
// reply, and the contract pi-subagents holds an intercom provider to.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { parseConfig } from "./config.ts";
import { Intercom, SESSION_IDENTITY_EVENT } from "./runtime.ts";

type Handler = (payload: unknown) => void;

function fakePi(sessionName?: string) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		sent: [] as Array<{ message: { customType: string; content: string; details?: unknown }; options?: { deliverAs?: string } }>,
		prompts: [] as string[],
		entries: [] as Array<{ type: string; data: unknown }>,
		name: sessionName,
		events: {
			on(event: string, handler: Handler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
			},
			emit(event: string, payload: unknown) {
				for (const h of handlers.get(event) ?? []) h(payload);
			},
		},
		sendMessage(message: never, options?: never) {
			pi.sent.push({ message, options });
		},
		sendUserMessage(text: string) {
			pi.prompts.push(text);
		},
		appendEntry(type: string, data: unknown) {
			pi.entries.push({ type, data });
		},
		getSessionName: () => pi.name,
	};
	return pi;
}

function fakeCtx(id: string, cwd = "/tmp") {
	const ctx = {
		idle: true,
		sessionManager: { getSessionId: () => id, getSessionFile: () => undefined, getBranch: () => [] },
		cwd,
		model: { id: "test-model" },
		hasUI: false,
		isIdle: () => ctx.idle,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		ui: { notify() {}, confirm: async () => true },
	};
	return ctx;
}

const config = parseConfig({ brokerCommand: process.execPath, brokerArgs: [], inboundTrigger: "replies", claude: { enabled: false } });
let dir: string;
const previous = process.env.PI_CODING_AGENT_DIR;
const previousId = process.env.PI_INTERCOM_SESSION_ID;

beforeAll(() => {
	// Short, under /tmp: a Unix socket path has to fit in about 104 bytes.
	dir = mkdtempSync("/tmp/pir-");
	process.env.PI_CODING_AGENT_DIR = dir;
});

afterAll(async () => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	// Give the broker its 5 s idle shutdown before the directory goes.
	await Bun.sleep(5500);
	rmSync(dir, { recursive: true, force: true });
}, 10_000);

async function session(id: string, name: string) {
	const pi = fakePi(name);
	const ctx = fakeCtx(id);
	const runtime = new Intercom(pi as never, config);
	const off = runtime.subscribe();
	runtime.start(ctx as never);
	await runtime.connect();
	return { pi, ctx, runtime, off };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(20);
	}
}

describe("pi-subagents contract", () => {
	it("lets a claim made synchronously at session start become the id, and publishes it", async () => {
		const pi = fakePi();
		pi.events.on(SESSION_IDENTITY_EVENT, (request) => (request as { claim(id: string): void }).claim("subagent-worker-run1-1"));
		const runtime = new Intercom(pi as never, config);
		runtime.start(fakeCtx("session-abc") as never);
		expect(process.env.PI_INTERCOM_SESSION_ID).toBe("subagent-worker-run1-1");
		await runtime.shutdown();
		expect(process.env.PI_INTERCOM_SESSION_ID).toBe(previousId);
	});

	it("delivers a result addressed to this session locally and acknowledges it", async () => {
		const pi = fakePi();
		const runtime = new Intercom(pi as never, config);
		const off = runtime.subscribe();
		runtime.start(fakeCtx("session-0123456789abcdefghij") as never);
		const acks: unknown[] = [];
		pi.events.on("subagent:result-intercom-delivery", (a) => acks.push(a));
		pi.events.emit("subagent:result-intercom", { to: "subagent-chat-0123456789abcdefgh", message: "child done", requestId: "r1" });
		expect(acks).toEqual([{ requestId: "r1", delivered: true }]);
		expect(pi.sent[0]?.message.customType).toBe("intercom_message");
		expect(pi.prompts).toEqual(["New intercom message above."]);
		off();
		await runtime.shutdown();
	});
});

describe("between two sessions", () => {
	it("lists, sends without triggering, asks and gets the reply", async () => {
		const a = await session("aaaaaaaa-1111", "alpha");
		const b = await session("bbbbbbbb-2222", "beta");

		const list = await a.runtime.list();
		expect(list.content[0]!.text).toContain("• beta (bbbbbbbb)");
		expect(list.content[0]!.text).toContain("Claude Code peering is off");

		// An unsolicited send is shown but does not start a turn under "replies".
		expect((await a.runtime.send(a.ctx as never, { to: "beta", message: "fyi" })).details.delivered).toBe(true);
		await until(() => b.pi.sent.length === 1);
		expect(b.pi.sent[0]!.options).toEqual({ deliverAs: "steer" });
		expect(b.pi.prompts).toEqual([]);

		// An ask blocks until the reply arrives; the reply resolves it.
		const asked = a.runtime.ask(a.ctx as never, { to: "beta", message: "what is 2+2?" });
		await until(() => b.runtime.tracker.pending().length === 1);
		expect((await b.runtime.reply({ message: "4" })).details.delivered).toBe(true);
		expect((await asked).content[0]!.text).toBe("**Reply from beta:**\n4");

		for (const s of [a, b]) {
			s.off();
			await s.runtime.shutdown();
		}
	});

	it("holds a message for a busy session with no one at the keyboard, then delivers it", async () => {
		const a = await session("cccccccc-3333", "gamma");
		const b = await session("dddddddd-4444", "delta");
		b.ctx.idle = false;
		b.runtime.agentStart();
		await a.runtime.send(a.ctx as never, { to: "delta", message: "later" });
		await Bun.sleep(300);
		expect(b.pi.sent).toEqual([]);
		b.ctx.idle = true;
		b.runtime.agentEnd();
		await until(() => b.pi.sent.length === 1);
		for (const s of [a, b]) {
			s.off();
			await s.runtime.shutdown();
		}
	});
});
