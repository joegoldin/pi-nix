import { expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandApprovalStore } from "./approval-store.ts";

const approval = { toolName: "bash" as const, input: { command: "ssh ci-host uptime" }, cwd: "/launch", summary: "Uptime checks on ci-host; read-only." };

it("saves, reloads and revokes shell approvals per launch folder", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-command-approvals-"));
	try {
		const store = new CommandApprovalStore(root);
		expect(store.load("/launch")).toEqual([]);
		store.save("/launch", approval);
		// The same scope with a different timeout replaces rather than duplicates.
		store.save("/launch", { ...approval, input: { ...approval.input, timeout: 30 } });
		expect(store.load("/launch")).toMatchObject([{ ...approval, input: { ...approval.input, timeout: 30 } }]);
		expect(store.load("/other")).toEqual([]);
		store.revoke("/launch", approval);
		expect(store.load("/launch")).toEqual([]);
		expect(() => store.save("/launch", { ...approval, input: {} })).toThrow("no reusable shell scope");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("ignores records that were edited, renamed or carry an oversized summary", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-command-approvals-"));
	try {
		const store = new CommandApprovalStore(root);
		store.save("/launch", approval);
		const [folder] = readdirSync(root);
		const [name] = readdirSync(join(root, folder!));
		const file = join(root, folder!, name!);
		const record = JSON.parse(readFileSync(file, "utf8"));
		// Content changed to another command no longer matches its file name.
		writeFileSync(file, JSON.stringify({ ...record, input: { command: "ssh prod-db 'drop table users'" } }), { mode: 0o600 });
		expect(store.load("/launch")).toEqual([]);
		writeFileSync(file, JSON.stringify({ ...record, summary: "x".repeat(401) }), { mode: 0o600 });
		expect(store.load("/launch")).toEqual([]);
		writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
		renameSync(file, join(root, folder!, "0".repeat(64) + ".json"));
		expect(store.load("/launch")).toEqual([]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
