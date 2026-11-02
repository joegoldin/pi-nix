import { expect, test } from "bun:test";
import { registerPeerCompletion } from "./completion.ts";

function harness() {
	const handlers = new Map<string, Function>();
	const sent: any[] = [], notices: string[] = [], entries: any[] = [];
	let auto = false, consent = false, pending = false, owner = "peer-session", stopped = 0;
	let blockers: string[] = [], runtimeBlockers: string[] = [];
	let delivery = { delivered: true, delivery: "socket_delivered", messageId: "report-1" };
	const pi = {
		registerFlag(name: string, options: any) { expect(name).toBe("peer-auto-exit"); expect(options.default).toBe(false); },
		getFlag: () => auto,
		on: (name: string, fn: Function) => handlers.set(name, fn),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
	};
	const ctx = {
		hasUI: true,
		cwd: "/work",
		sessionManager: { getSessionId: () => owner },
		hasPendingMessages: () => pending,
		shutdown: () => { stopped++; },
		ui: { confirm: async () => consent, notify: (text: string) => notices.push(text), setProgramStatus() {} },
	};
	const runtime = {
		send: async (_ctx: unknown, request: unknown) => { sent.push(request); return { content: [{ type: "text", text: "Report sent" }], details: delivery }; },
		exitBlockers: () => runtimeBlockers,
	};
	const complete = registerPeerCompletion(pi as never, () => runtime as never, () => blockers);
	return { ctx, runtime, sent, entries, notices, complete,
		auto: () => { auto = true; }, consent: () => { consent = true; }, busy: (reasons: string[]) => { blockers = reasons; },
		runtimeBusy: (reasons: string[]) => { runtimeBlockers = reasons; }, queued: () => { pending = true; },
		switchSession: () => { owner = "another-session"; }, failed: () => { delivery = { ...delivery, delivered: false, delivery: "queued" }; },
		stopped: () => stopped,
		emit: (name: string, event: object = {}) => handlers.get(name)?.(event, ctx),
		settle: () => handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx),
	};
}
const request = { to: "requester", message: "Reviewed src/parser.ts; tests passed.", requestCleanup: true };

test("completion reports evidence and a cleanup request without closing anything by default", async () => {
	const h = harness();
	const result = await h.complete("call-1", h.ctx as never, request);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]).toMatchObject({ to: "requester", message: expect.stringContaining(request.message) });
	const metadata = JSON.parse(h.sent[0].attachments[0].content);
	expect(metadata).toMatchObject({ version: 1, piSessionId: "peer-session", requestCleanup: true, quit: "keep" });
	expect(result.details.exit).toBe("kept_open");
	h.settle(); expect(h.stopped()).toBe(0);
});

test("asking to quit requires local user consent and defers exit until the final reply is saved", async () => {
	const h = harness(); h.consent();
	const result = await h.complete("call-1", h.ctx as never, { ...request, quit: "ask" });
	expect(result.details.exit).toBe("scheduled");
	expect(h.stopped()).toBe(0);
	h.settle(); expect(h.stopped()).toBe(1);
});

test("a declined quit request keeps the peer open", async () => {
	const h = harness();
	const result = await h.complete("call-1", h.ctx as never, { ...request, quit: "ask" });
	expect(result.details.exit).toBe("declined"); h.settle(); expect(h.stopped()).toBe(0);
});

test("automatic exit requires explicit launch-time opt-in, not a peer message", async () => {
	const h = harness();
	const result = await h.complete("call-1", h.ctx as never, { ...request, quit: "auto" });
	expect(result.details.error).toBe(true); expect(h.sent).toHaveLength(0);
	h.auto();
	expect((await h.complete("call-2", h.ctx as never, { ...request, quit: "auto" })).details.exit).toBe("scheduled");
	h.settle(); expect(h.stopped()).toBe(1);
});

test("headless peers cannot manufacture consent for an ask-to-quit request", async () => {
	const h = harness(); h.ctx.hasUI = false; h.consent();
	const result = await h.complete("call-1", h.ctx as never, { ...request, quit: "ask" });
	expect(result.details.exit).toBe("unavailable"); h.settle(); expect(h.stopped()).toBe(0);
});

for (const reason of ["background task running", "/btw turn running", "active /goal"]) {
	test(`completion cannot terminate ${reason}`, async () => {
		const h = harness(); h.auto(); h.busy([reason]);
		const result = await h.complete("call-1", h.ctx as never, { ...request, quit: "auto" });
		expect(h.sent).toHaveLength(1); expect(result.details.exit).toBe("blocked");
		h.settle(); expect(h.stopped()).toBe(0);
	});
}

test("undelivered or merely queued reports never authorize exit", async () => {
	const h = harness(); h.auto(); h.failed();
	await h.complete("call-1", h.ctx as never, { ...request, quit: "auto" });
	h.settle(); expect(h.stopped()).toBe(0);
});

for (const change of ["queued", "busy", "runtimeBusy", "switchSession", "input", "abort"] as const) {
	test(`rechecks ${change} before an already authorized exit`, async () => {
		const h = harness(); h.auto(); const controller = new AbortController();
		await h.complete("call-1", h.ctx as never, { ...request, quit: "auto" }, controller.signal);
		if (change === "busy" || change === "runtimeBusy") h[change](["new work"]);
		else if (change === "input") h.emit("input");
		else if (change === "abort") controller.abort();
		else h[change]();
		h.settle(); expect(h.stopped()).toBe(0);
	});
}

test("an interrupted or failed final turn preserves the peer", async () => {
	for (const stopReason of ["aborted", "error", "toolUse"]) {
		const h = harness(); h.auto();
		await h.complete("call-1", h.ctx as never, { ...request, quit: "auto" });
		h.emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
		expect(h.stopped()).toBe(0);
	}
});


test("a cancelled automatic exit does not grant auto-exit to later work", async () => {
	const h = harness(); h.auto();
	await h.complete("call-1", h.ctx as never, { ...request, quit: "auto" });
	h.emit("input");
	expect((await h.complete("call-2", h.ctx as never, { ...request, quit: "auto" })).details.error).toBe(true);
	h.settle(); expect(h.stopped()).toBe(0);
});

test("new work during local confirmation cancels exit after the answer", async () => {
	const h = harness();
	h.ctx.ui.confirm = async () => { h.busy(["new background task"]); return true; };
	const result = await h.complete("call-1", h.ctx as never, { ...request, quit: "ask" });
	expect(result.details.exit).toBe("blocked"); h.settle(); expect(h.stopped()).toBe(0);
});


for (const role of ["user", "custom"]) {
	test(`new ${role} transcript work cancels an approved exit even when its queue is already consumed`, async () => {
		const h = harness(); h.auto();
		await h.complete("call-1", h.ctx as never, { ...request, quit: "auto" });
		h.emit("message_start", { message: { role } }); h.settle(); expect(h.stopped()).toBe(0);
	});
}

test("new peer work while sending the completion report prevents scheduling exit", async () => {
	const h = harness(); h.auto();
	h.runtime.send = async () => { h.emit("message_start", { message: { role: "custom" } }); return { content: [{ type: "text", text: "delivered" }], details: { delivered: true, delivery: "socket_delivered", messageId: "report-1" } }; };
	const result = await h.complete("call-1", h.ctx as never, { ...request, quit: "auto" });
	expect(result.details.exit).toBe("blocked"); h.settle(); expect(h.stopped()).toBe(0);
});

test("new peer work during local confirmation prevents scheduling exit", async () => {
	const h = harness();
	h.ctx.ui.confirm = async () => { h.emit("message_start", { message: { role: "custom" } }); return true; };
	const result = await h.complete("call-1", h.ctx as never, { ...request, quit: "ask" });
	expect(result.details.exit).toBe("blocked"); h.settle(); expect(h.stopped()).toBe(0);
});
