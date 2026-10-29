import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryGrantStore } from "./directory-store.ts";

test("future grants belong to the exact launch folder, not the target or its parent", () => {
	const root = mkdtempSync(join(tmpdir(), "saved-directories-"));
	try {
		const launch = join(root, "launch"); const target = join(root, "target");
		mkdirSync(launch); mkdirSync(target);
		const store = new DirectoryGrantStore(join(root, "storage"));
		const directory = { path: target, access: "write-execute" as const };
		store.save(launch, directory);
		expect(new DirectoryGrantStore(join(root, "storage")).load(launch)).toEqual([{ directory, at: expect.any(Number) }]);
		expect(store.load(target)).toEqual([]);
		expect(store.load(root)).toEqual([]);
		expect(store.load(join(launch, "subfolder"))).toEqual([]);
		store.revoke(launch, directory);
		expect(store.load(launch)).toEqual([]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrupt, writable-by-others, symlinked and changed-target records grant nothing", () => {
	const root = mkdtempSync(join(tmpdir(), "saved-directory-safety-"));
	try {
		const target = join(root, "target"); const elsewhere = join(root, "elsewhere");
		mkdirSync(target); mkdirSync(elsewhere);
		const storage = join(root, "storage"); const store = new DirectoryGrantStore(storage);
		const directory = { path: target, access: "write" as const };
		store.save(root, directory);
		const folder = join(storage, readdirSync(storage)[0]!);
		const file = join(folder, readdirSync(folder)[0]!);
		const good = readFileSync(file, "utf8");
		writeFileSync(file, "not JSON"); expect(store.load(root)).toEqual([]);
		writeFileSync(file, good); chmodSync(file, 0o666); expect(store.load(root)).toEqual([]);
		chmodSync(file, 0o600);
		const renamed = `${file}.original`; renameSync(file, renamed); symlinkSync(renamed, file);
		expect(store.load(root)).toEqual([]);
		rmSync(file); renameSync(renamed, file);
		renameSync(target, `${target}-original`); symlinkSync(elsewhere, target);
		expect(store.load(root)).toEqual([]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("tools cannot write saved permission controls directly", async () => {
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
	const { deterministicHardDeny } = await import("./auto/hard-deny.ts");
	const path = join(getAgentDir(), "permissions/directory-grants/folder/grant.json");
	expect(deterministicHardDeny("write", { path, content: "{}" }, tmpdir())).toContain("safety-control");
	expect(deterministicHardDeny("bash", { command: `printf x > ${JSON.stringify(path)}` }, tmpdir())).toContain("safety-control");
});

test("unsafe or symlinked storage directories cannot supply, replace or revoke grants", () => {
	for (const container of ["root", "workspace"]) {
		const root = mkdtempSync(join(tmpdir(), "saved-directory-container-"));
		try {
			const target = join(root, "target"); mkdirSync(target);
			const storage = join(root, "storage"); const store = new DirectoryGrantStore(storage);
			const directory = { path: target, access: "write" as const };
			store.save(root, directory);
			const folder = join(storage, readdirSync(storage)[0]!);
			const path = container === "root" ? storage : folder;
			chmodSync(path, 0o777);
			expect(store.load(root)).toEqual([]);
			expect(() => store.save(root, directory)).toThrow("Unsafe permission storage directory");
			expect(() => store.revoke(root, directory)).toThrow("Unsafe permission storage directory");
			chmodSync(path, 0o700);
			expect(store.load(root)).toHaveLength(1);
			const original = `${path}-original`;
			renameSync(path, original); symlinkSync(original, path);
			expect(store.load(root)).toEqual([]);
			expect(() => store.save(root, directory)).toThrow("Unsafe permission storage directory");
			expect(() => store.revoke(root, directory)).toThrow("Unsafe permission storage directory");
			rmSync(path); renameSync(original, path);
			expect(store.load(root)).toHaveLength(1);
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});
