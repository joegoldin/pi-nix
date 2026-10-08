import { describe, expect, it } from "bun:test";
import { DENIAL_LIMIT, grantKey, PermissionLedger } from "./denials.ts";

const blocked = (command: string, toolCallId = "c1") => ({ toolCallId, toolName: "bash", input: { command }, reason: "no" });

describe("the permission ledger", () => {
	it("keeps denials newest first, up to its limit", () => {
		const l = new PermissionLedger();
		for (let i = 0; i < DENIAL_LIMIT + 5; i++) l.record(blocked(`echo ${i}`));
		expect(l.list()).toHaveLength(DENIAL_LIMIT);
		expect((l.list()[0]!.input as { command: string }).command).toBe(`echo ${DENIAL_LIMIT + 4}`);
	});

	it("grants exactly the approved call, and settles every open denial of it", () => {
		const l = new PermissionLedger();
		const a = l.record(blocked("rm -rf build", "c1"));
		l.record(blocked("rm -rf build", "c2"));
		l.record(blocked("rm -rf dist", "c3"));
		l.approve(a.id);
		expect(l.isGranted("bash", { command: "rm -rf build" })).toBe(true);
		expect(l.isGranted("bash", { command: "rm -rf dist" })).toBe(false);
		expect(l.isGranted("bash", { command: "rm -rf build", timeout: 5 })).toBe(false);
		expect(l.open().map((d) => d.toolCallId)).toEqual(["c3"]);
	});

	it("matches a grant whatever the input's key order", () => {
		expect(grantKey("edit", { path: "a", oldText: "x" })).toBe(grantKey("edit", { oldText: "x", path: "a" }));
	});

	it("dismisses without granting, and revokes a grant", () => {
		const l = new PermissionLedger();
		const a = l.record(blocked("ls"));
		l.dismiss(a.id);
		expect(l.open()).toEqual([]);
		expect(l.isGranted("bash", { command: "ls" })).toBe(false);
		const b = l.record(blocked("pwd"));
		l.approve(b.id);
		l.revoke(l.grantList()[0]!.key);
		expect(l.isGranted("bash", { command: "pwd" })).toBe(false);
	});

	it("survives a round trip through the session", () => {
		const l = new PermissionLedger();
		const a = l.record(blocked("ls"));
		l.approve(a.id);
		l.record(blocked("pwd"));
		const restored = new PermissionLedger();
		restored.restore(JSON.parse(JSON.stringify(l.snapshot())));
		expect(restored.isGranted("bash", { command: "ls" })).toBe(true);
		expect(restored.open()).toHaveLength(1);
		// New denials do not reuse an id already given.
		const c = restored.record(blocked("whoami"));
		expect(restored.list().filter((d) => d.id === c.id)).toHaveLength(1);
	});
});
