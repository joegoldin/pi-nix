// Two runtimes over a real broker, with pi faked: the inbox policy, ask and
// reply, and ordinary session identity.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { parseConfig } from "./config.ts";
import { Intercom } from "./runtime.ts";

type Handler = (payload: unknown) => void;

function fakePi(sessionName?: string) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		sent: [] as Array<{ message: { customType: string; content: string; details?: unknown }; options?: { deliverAs?: string; triggerTurn?: boolean } }>,
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
	runtime.start(ctx as never);
	await runtime.connect();
	return { pi, ctx, runtime };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(20);
	}
}

describe("session identity", () => {
	it("uses the native Pi id, without asking a child plugin to claim it", async () => {
		const pi = fakePi();
		let claims = 0;
		pi.events.on("intercom:session-identity", (request) => {
			claims++;
			(request as { claim(id: string): void }).claim("legacy-child-id");
		});
		const runtime = new Intercom(pi as never, config);
		try {
			runtime.start(fakeCtx("session-abc") as never);
			expect(process.env.PI_INTERCOM_SESSION_ID).toBe("session-abc");
			expect(claims).toBe(0);
		} finally { await runtime.shutdown(); }
		expect(process.env.PI_INTERCOM_SESSION_ID).toBe(previousId);
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
		expect(a.runtime.exitBlockers("completion-call")).toContain("An outbound peer ask is still waiting");
		expect(b.runtime.exitBlockers("completion-call")).toContain("Unanswered peer asks need attention");
		expect((await b.runtime.reply({ message: "4" })).details.delivered).toBe(true);
		expect((await asked).content[0]!.text).toBe("**Reply from beta:**\n4");
		expect(a.runtime.exitBlockers("completion-call")).toEqual([]);
		expect(b.runtime.exitBlockers("completion-call")).toEqual([]);

		for (const s of [a, b]) {
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
			await s.runtime.shutdown();
		}
	});
});
