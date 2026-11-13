import { expect, it } from "bun:test";
import { REMOTE_REVIEW_REGISTER, RemotePermissionReview, type RemoteReviewRegistration } from "./remote-review.ts";

function setup() {
	const listeners = new Map<string, (value: unknown) => void>();
	const events = { on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => listeners.delete(name); } };
	const remote = new RemotePermissionReview(events as never);
	let session = "native-session";
	const ctx = { mode: "rpc", hasUI: true, cwd: "/tmp/project", sessionManager: {getSessionId: () => session}, signal: new AbortController().signal };
	remote.begin(ctx as never);
	let asked = 0, live = true, request: any;
	let select = async (question: any, _signal: AbortSignal): Promise<string | undefined> => { asked++; request = question; return question.options.at(-1); };
	const registration: RemoteReviewRegistration = { version: 1, sessionId: session, scopeId: "attempt-one", isLive: () => live, select: (question, signal) => select(question, signal) };
	const register = () => listeners.get(REMOTE_REVIEW_REGISTER)!(registration);
	const ask = { toolName: "read", input: { path: "/private/result.json" }, reason: "Review original action", scope: "Read-only /private/result.json", scopeOnly: true, timeoutSeconds: 1 };
	return {remote, ctx, ask, registration, register, asked: () => asked, request: () => request, setSession(value: string) {session = value;}, setLive(value: boolean) {live = value;}, setSelect(fn: typeof select) {select = fn;} };
}

it("RPC approval is unavailable without an explicitly registered live same-session provider", async () => {
	const h = setup();
	expect(h.remote.available(h.ctx as never)).toBe(false);
	expect(await h.remote.ask(h.ctx as never, h.ask)).toBeUndefined();
	expect(h.asked()).toBe(0);
	h.registration.sessionId = "different"; h.register(); expect(h.registration.accepted).not.toBe(true);
	h.registration.sessionId = "native-session"; h.register(); expect(h.registration.accepted).toBe(true);
	expect(h.remote.available(h.ctx as never)).toBe(true);
	h.setLive(false); expect(h.remote.available(h.ctx as never)).toBe(false);
});

it("the provider receives the complete immutable native action, scope and fixed bounded choices", async () => {
	const h = setup(); h.register();
	expect(await h.remote.ask(h.ctx as never, h.ask)).toBe("allow-session");
	const q = h.request();
	expect(q.sessionId).toBe("native-session"); expect(q.scopeId).toBe("attempt-one");
	expect(q.title).toContain(h.ask.input.path); expect(q.title).toContain(h.ask.scope);
	expect(q.title).toContain(h.ask.reason); expect(q.title).toContain("read");
	expect(q.options).toEqual(["Deny", "Allow the displayed session scope"]);
	expect(q.timeoutMs).toBe(1000); expect(Object.isFrozen(q)).toBe(true); expect(Object.isFrozen(q.options)).toBe(true);
	expect(q.options.some((value: string) => /future/i.test(value))).toBe(false);
});

it("remote responses cannot fabricate a choice or upgrade exact-only review into reusable authority", async () => {
	for (const answer of ["made up", "Allow the displayed session scope", undefined]) {
		const h = setup(); h.register(); h.setSelect(async () => answer);
		expect(await h.remote.ask(h.ctx as never, {...h.ask, scope: undefined, scopeOnly: false})).not.toBe("allow-session");
	}
	const h = setup(); h.register(); h.setSelect(async () => "Deny");
	expect(await h.remote.ask(h.ctx as never, h.ask)).toBe("deny");
});

it("changed arguments, session, provider lifetime or cancellation cannot accept a late response", async () => {
	for (const change of [
		(h: ReturnType<typeof setup>) => {h.ask.input.path = "/private/changed.json";},
		(h: ReturnType<typeof setup>) => h.setSession("replacement"),
		(h: ReturnType<typeof setup>) => h.setLive(false),
		(h: ReturnType<typeof setup>) => h.registration.dispose!(),
		(h: ReturnType<typeof setup>) => h.remote.begin(h.ctx as never),
	]) {
		const h = setup(); h.register(); h.setSelect(async () => {change(h); return "Allow the displayed session scope";});
		expect(await h.remote.ask(h.ctx as never, h.ask)).not.toBe("allow-session");
	}
	const h = setup(), abort = new AbortController(); h.ctx.signal = abort.signal; h.register();
	h.setSelect(async () => {abort.abort(); return "Allow the displayed session scope";});
	expect(await h.remote.ask(h.ctx as never, h.ask)).not.toBe("allow-session");
});

it("unresponsive providers expire and oversize actions fail without truncated reviews", async () => {
	const h = setup(); h.register(); h.setSelect(() => new Promise(() => {}));
	expect(await h.remote.ask(h.ctx as never, {...h.ask, timeoutSeconds: 0.01})).not.toBe("allow-session");
	const huge = setup(); huge.register();
	expect(await huge.remote.ask(huge.ctx as never, {...huge.ask, input: {text: "x".repeat(40000)}})).toBeUndefined();
	expect(huge.asked()).toBe(0);
});
