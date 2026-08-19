import { describe, expect, it, mock } from "bun:test";
import {
	AUTHORIZER_NAME,
	attachAuthorizer,
	getPermissionsService,
	makeAuthorizer,
	PERMISSION_SERVICE_KEY,
	requestFromDetails,
} from "./authorizer.ts";

describe("PERMISSION_SERVICE_KEY", () => {
	it("is the exact symbol pi-permission-system publishes on", () => {
		expect(PERMISSION_SERVICE_KEY).toBe(Symbol.for("@gotgenes/pi-permission-system:service"));
	});
});

describe("getPermissionsService", () => {
	it("returns undefined when nothing is published", () => {
		expect(getPermissionsService({} as never)).toBeUndefined();
	});

	it("returns the published service", () => {
		const service = { registerAuthorizer: mock(() => () => {}) };
		expect(getPermissionsService({ [PERMISSION_SERVICE_KEY]: service } as never)).toBe(service);
	});

	it("returns undefined when the slot holds something without registerAuthorizer", () => {
		expect(getPermissionsService({ [PERMISSION_SERVICE_KEY]: { nope: 1 } } as never)).toBeUndefined();
	});
});

describe("requestFromDetails", () => {
	it("maps a bash ask onto a ToolRequest", () => {
		expect(requestFromDetails({ requestId: "r1", toolCallId: "c1", toolName: "bash", command: "rm -rf /" })).toEqual({
			toolName: "bash",
			toolCallId: "c1",
			surface: "bash",
			value: "rm -rf /",
			input: {},
		});
	});

	it("prefers command, then path, then target, then value", () => {
		expect(requestFromDetails({ toolName: "read", path: "/etc/shadow" }).value).toBe("/etc/shadow");
		expect(requestFromDetails({ toolName: "x", target: "t" }).value).toBe("t");
		expect(requestFromDetails({ toolName: "x", value: "v" }).value).toBe("v");
	});

	it("takes the package's own surface when it supplies one", () => {
		expect(requestFromDetails({ toolName: "my_ext:fetch", surface: "external_directory", path: "/tmp" }).surface).toBe(
			"external_directory",
		);
	});

	it("falls back to an empty tool call id and value", () => {
		expect(requestFromDetails({})).toEqual({ toolName: "", toolCallId: "", surface: "tool", value: "", input: {} });
	});
});

describe("makeAuthorizer", () => {
	const details = { requestId: "r1", toolCallId: "c1", toolName: "bash", command: "rm -rf build" };
	const query = { checkPermission: mock(() => {}), getToolPermission: mock(() => {}) };
	const newLog = () => ({ review: mock(() => {}), debug: mock(() => {}) });

	it("returns allow when the classifier allows", async () => {
		const authorize = makeAuthorizer({
			classify: mock(async () => ({ decision: "allow", rule_kind: "none", reason: "ok" }) as const),
			userTurns: () => [],
			onPrompt: mock(() => {}),
		});
		expect(await authorize(details as never, query as never, newLog() as never)).toEqual({ kind: "allow" });
	});

	it("returns deny with the classifier's reason", async () => {
		const authorize = makeAuthorizer({
			classify: mock(async () => ({ decision: "deny", rule_kind: "soft_deny", reason: "not asked for" }) as const),
			userTurns: () => [],
			onPrompt: mock(() => {}),
		});
		expect(await authorize(details as never, query as never, newLog() as never)).toEqual({
			kind: "deny",
			reason: "not asked for",
		});
	});

	it("denies a hard_deny even when the classifier says allow", async () => {
		const authorize = makeAuthorizer({
			classify: mock(async () => ({ decision: "allow", rule_kind: "hard_deny", reason: "ssh key" }) as const),
			userTurns: () => [],
			onPrompt: mock(() => {}),
		});
		const verdict = await authorize(details as never, query as never, newLog() as never);
		expect(verdict.kind).toBe("deny");
	});

	it("defers on classifier failure so the chain owner's own prompt path runs", async () => {
		const onPrompt = mock(() => {});
		const authorize = makeAuthorizer({
			classify: mock(async () => {
				throw new Error("429");
			}),
			userTurns: () => [],
			onPrompt,
		});
		expect(await authorize(details as never, query as never, newLog() as never)).toEqual({ kind: "defer" });
		expect(onPrompt).toHaveBeenCalledTimes(1);
	});

	it("never answers allow on failure, because a chain link that fails open widens permissions", async () => {
		const authorize = makeAuthorizer({
			classify: mock(async () => {
				throw new Error("boom");
			}),
			userTurns: () => [],
			onPrompt: mock(() => {}),
		});
		expect((await authorize(details as never, query as never, newLog() as never)).kind).not.toBe("allow");
	});

	it("writes a review-log entry keyed to the request id", async () => {
		const log = newLog();
		const authorize = makeAuthorizer({
			classify: mock(async () => ({ decision: "allow", rule_kind: "allow", reason: "r" }) as const),
			userTurns: () => [],
			onPrompt: mock(() => {}),
		});
		await authorize(details as never, query as never, log as never);
		expect(log.review).toHaveBeenCalledTimes(1);
		const [name, payload] = log.review.mock.calls[0]! as [string, Record<string, unknown>];
		expect(name).toBe(AUTHORIZER_NAME);
		expect(payload.requestId).toBe("r1");
		expect(payload.decision).toBe("allow");
	});
});

describe("attachAuthorizer", () => {
	const deps = () => ({
		classify: mock(async () => ({ decision: "allow", rule_kind: "none", reason: "" }) as const),
		userTurns: () => [],
		onPrompt: mock(() => {}),
	});

	function host() {
		const channels = new Map<string, (data: unknown) => void>();
		return {
			events: {
				on: (channel: string, handler: (data: unknown) => void) => {
					channels.set(channel, handler);
					return () => channels.delete(channel);
				},
			},
			channels,
		};
	}

	it("reports false and registers nothing when the service is absent", () => {
		const h = host();
		expect(attachAuthorizer(h as never, deps, {} as never)).toBe(false);
		expect(h.channels.has("permissions:ready")).toBe(true);
	});

	it("registers on the published service and reports true", () => {
		const registerAuthorizer = mock(() => () => {});
		const global = { [PERMISSION_SERVICE_KEY]: { registerAuthorizer } };
		expect(attachAuthorizer(host() as never, deps, global as never)).toBe(true);
		expect(registerAuthorizer).toHaveBeenCalledTimes(1);
		expect(registerAuthorizer.mock.calls[0]![0]).toBe(AUTHORIZER_NAME);
	});

	it("registers again when the service republishes on permissions:ready", () => {
		const registerAuthorizer = mock(() => () => {});
		const global = { [PERMISSION_SERVICE_KEY]: { registerAuthorizer } };
		const h = host();
		attachAuthorizer(h as never, deps, global as never);
		h.channels.get("permissions:ready")!(undefined);
		expect(registerAuthorizer).toHaveBeenCalledTimes(2);
	});

	it("survives the duplicate-registration throw the package documents", () => {
		const registerAuthorizer = mock(() => {
			throw new Error("authorizer already registered");
		});
		const global = { [PERMISSION_SERVICE_KEY]: { registerAuthorizer } };
		expect(attachAuthorizer(host() as never, deps, global as never)).toBe(false);
	});
});
