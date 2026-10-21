import { describe, expect, it } from "bun:test";
import { DENIAL_LIMIT, grantKey, PermissionLedger } from "./denials.ts";

const blocked = (command: string, toolCallId = "c1") => ({ toolCallId, toolName: "bash", input: { command }, reason: "no" });

describe("the permission ledger", () => {
	it("makes new shell scope approvals available for classifier review of variants", () => {
		const ledger = new PermissionLedger(() => 123);
		const input = { command: "ssh torrent 'diagnose --output /tmp/check-a.txt'" };
		const grant = ledger.approveSimilar("bash", input, "/work")!;
		expect(grant.scope?.label).toContain("Similar shell actions");
		expect(grant.scope?.label).toContain("rechecked");
		expect(typeof ledger.scenarioApprovals).toBe("function");
		const approvals = ledger.scenarioApprovals("bg_run", "/work");
		expect(approvals).toHaveLength(1);
		expect(approvals[0]).toMatchObject({ toolName: "bash", input, cwd: "/work", at: 123 });
		expect(ledger.isSimilarlyGranted("bash", { command: "ssh torrent 'diagnose --output /tmp/check-b.txt'" }, "/work")).toBe(false);
		expect(ledger.scenarioApprovals("bash", "/elsewhere")).toEqual([]);
		expect(ledger.scenarioApprovals("write", "/work")).toEqual([]);
		const restored = new PermissionLedger();
		restored.restore(ledger.snapshot());
		expect(restored.scenarioApprovals("bash", "/work")).toEqual(approvals);
		restored.revoke(grant.key);
		expect(restored.scenarioApprovals("bash", "/work")).toEqual([]);
		ledger.clearSimilar();
		expect(ledger.scenarioApprovals("bash", "/work")).toEqual([]);
	});

	it("does not silently widen old exact-command grants into scenario approvals", () => {
		const ledger = new PermissionLedger();
		ledger.approveSimilar("bash", { command: "ssh torrent diagnose" }, "/work");
		const saved = ledger.snapshot();
		delete saved.grants[0]!.scope!.scenario;
		ledger.restore(saved);
		expect(typeof ledger.scenarioApprovals).toBe("function");
		expect(ledger.scenarioApprovals("bash", "/work")).toEqual([]);
		expect(ledger.isSimilarlyGranted("bash", { command: "ssh torrent diagnose" }, "/work")).toBe(true);
	});

	it("keeps the approved reference call independent of later input mutations", () => {
		const ledger = new PermissionLedger();
		const input = { command: "ssh torrent diagnose" };
		ledger.approveSimilar("bash", input, "/work");
		input.command = "ssh elsewhere change-service";
		const context = ledger.scenarioApprovals("bash", "/work");
		expect(context[0]!.input).toEqual({ command: "ssh torrent diagnose" });
		(context[0]!.input as { command: string }).command = "different";
		expect(ledger.scenarioApprovals("bash", "/work")[0]!.input).toEqual({ command: "ssh torrent diagnose" });
	});

	it("keeps exact command matching separate from scenario review", () => {
		const l = new PermissionLedger();
		l.approveSimilar("bash", { command: "nixfmt file.nix", timeout: 30 }, "/work");
		expect(l.isSimilarlyGranted("bash", { command: "nixfmt file.nix", timeout: 90 }, "/work")).toBe(true);
		expect(l.isSimilarlyGranted("bash", { command: "nixfmt other.nix" }, "/work")).toBe(false);
		expect(l.isSimilarlyGranted("bash", { command: "nixfmt file.nix" }, "/other")).toBe(false);
		expect(l.isGranted("bash", { command: "nixfmt file.nix", timeout: 30 })).toBe(false);
		const restored = new PermissionLedger();
		restored.restore(l.snapshot());
		expect(restored.isSimilarlyGranted("bash", { command: "nixfmt file.nix" }, "/work")).toBe(true);
		restored.revoke(restored.grantList()[0]!.key);
		expect(restored.isSimilarlyGranted("bash", { command: "nixfmt file.nix" }, "/work")).toBe(false);
	});

	it("file-edit approval covers new edits only to the named path and tool", () => {
		const l = new PermissionLedger();
		l.approveSimilar("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }, "/work");
		expect(l.isSimilarlyGranted("edit", { path: "/work/a.ts", edits: [{ oldText: "y", newText: "z" }] }, "/work")).toBe(true);
		expect(l.isSimilarlyGranted("edit", { path: "b.ts", edits: [] }, "/work")).toBe(false);
		expect(l.isSimilarlyGranted("write", { path: "a.ts", content: "z" }, "/work")).toBe(false);
	});
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

it("menu shell approvals enter the classifier scenario ledger instead of bypassing it", () => {
	const ledger = new PermissionLedger();
	const call = { command: "ssh host 'diagnose /tmp/a'" };
	const denial = ledger.record({ toolName: "bash", toolCallId: "menu", input: call, reason: "Needs approval" });
	ledger.approve(denial.id, "/tmp");
	expect(ledger.open()).toHaveLength(0);
	expect(ledger.isGranted("bash", call)).toBe(false);
	expect(ledger.scenarioApprovals("bash", "/tmp")).toMatchObject([{ input: call }]);
	expect(ledger.scenarioApprovals("bash", "/other")).toEqual([]);
	const restored = new PermissionLedger(); restored.restore(ledger.snapshot());
	expect(restored.scenarioApprovals("bg_run", "/tmp")).toHaveLength(1);
	restored.revoke(restored.grantList()[0]!.key);
	expect(restored.scenarioApprovals("bash", "/tmp")).toEqual([]);
	ledger.clearSimilar();
	expect(ledger.scenarioApprovals("bash", "/tmp")).toEqual([]);
});
