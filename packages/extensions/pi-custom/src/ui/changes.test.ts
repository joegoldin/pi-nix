import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ChangesView } from "./changes.ts";
import { readChanges } from "./changes-repo.ts";

const identity = (text: string) => text;
const theme = { fg: (_slot: string, text: string) => text, bold: identity, italic: identity };

for (const repository of ["git", "jj-colocated", "jj-detached"]) {
	test(`/changes reads live ${repository} files without updating repository state`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-changes-"));
		const put = (path: string, content: string) => writeFileSync(join(cwd, path), content);
		const run = (command: string, ...args: string[]) => execFileSync(command, args, {
			cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, JJ_USER: "Tester", JJ_EMAIL: "tester@example.invalid" },
		});
		try {
			if (repository === "git") run("git", "init");
			else {
				run("jj", "--config=fsmonitor.backend=none", "git", "init", ...(repository === "jj-detached" ? ["--no-colocate"] : []));
				// A host's Watchman trigger could independently snapshot fixture edits.
				run("jj", "--config=fsmonitor.backend=none", "config", "set", "--repo", "fsmonitor.backend", "none");
			}
			put("a file.txt", "first\nold\nlast\n");
			put("removed", "deleted\n");
			put(".gitignore", "ignored\n");
			if (repository === "git") {
				run("git", "add", ".");
				run("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
			} else run("jj", "commit", "-m", "initial");
			put("a file.txt", "first\nnew\nlast\n");
			put("fresh", "new file\n");
			put("ignored", "never shown\n");
			symlinkSync("nowhere", join(cwd, "link"));
			rmSync(join(cwd, "removed"));
			const state = () => ({
				index: repository === "jj-detached" ? undefined : readFileSync(join(cwd, ".git/index")),
				checkout: repository === "git" ? undefined : readFileSync(join(cwd, ".jj/working_copy/checkout")),
				tree: repository === "git" ? undefined : readFileSync(join(cwd, ".jj/working_copy/tree_state")),
				operations: repository === "git" ? undefined : readdirSync(join(cwd, ".jj/repo/op_store/operations")).sort(),
			});
			const before = state();
			const changes = await readChanges(cwd);
			expect(changes.entries.map(({ path, status }) => [path, status])).toEqual([
				["a file.txt", "M"], ["fresh", "A"], ["link", "A"], ["removed", "D"],
			]);
			expect(await changes.read(changes.entries[0]!)).toEqual({ before: "first\nold\nlast\n", after: "first\nnew\nlast\n" });
			expect(await changes.read(changes.entries[2]!)).toEqual({ before: "", after: "nowhere" });
			let closed = false;
			const view = new ChangesView(changes, theme, () => 12, () => readChanges(cwd), () => {}, () => { closed = true; });
			view.handleInput("\r");
			await waitFor(() => view.render(80).some((line) => line.includes("+new")));
			view.handleInput("\x1b[B");
			view.handleInput("\x1b[B");
			view.handleInput("o");
			expect(view.render(80)[0]).toBe("a file.txt:2 · working file");
			view.handleInput("\x1b");
			view.handleInput(" ");
			view.handleInput("\x1b");
			expect(view.render(80)[0]).toContain("1/4 reviewed");
			put("a file.txt", "first\nlater\nlast\n");
			await expect(changes.read(changes.entries[0]!)).rejects.toThrow("Press r to refresh");
			view.handleInput("r");
			await waitFor(() => view.render(80)[0]?.includes("0/4 reviewed") ?? false);
			view.handleInput("\x1b");
			expect(closed).toBe(true);
			expect(state()).toEqual(before);
		} finally {
			rmSync(cwd, { force: true, recursive: true });
		}
	});
}

async function waitFor(done: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (done()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Viewer did not update");
}
