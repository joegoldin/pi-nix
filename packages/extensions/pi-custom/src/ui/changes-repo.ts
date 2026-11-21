import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const previewLimit = 256 * 1024;
const listLimit = 32 * 1024 * 1024;

export type Blob = { mode: string; id: string; size: number };
export type Change = { path: string; before?: Blob; after?: Blob; status: "A" | "D" | "M" };
export type ChangesSnapshot = {
	kind: "Git" | "jj";
	root: string;
	entries: Change[];
	read(change: Change): Promise<{ before: string; after: string } | undefined>;
};

export function changeKey(change: Change): string {
	return JSON.stringify([change.path, change.before?.mode, change.before?.id, change.after?.mode, change.after?.id]);
}

function repoRoot(cwd: string): { kind: "Git" | "jj"; root: string } {
	for (let root = resolve(cwd); ; root = dirname(root)) {
		if (existsSync(join(root, ".jj"))) return { kind: "jj", root };
		if (existsSync(join(root, ".git"))) return { kind: "Git", root };
		if (root === dirname(root)) throw new Error("Not inside a Git or Jujutsu working copy.");
	}
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR";
}

const blobHash = (algorithm: string, size: number) => createHash(algorithm).update(`blob ${size}\0`);
const nulFields = (text: string) => text.split("\0").slice(0, -1);

/** Check ancestors as well as the final entry: a removed directory may now be an external symlink. */
function diskReader(root: string, algorithm: string) {
	const dirs = new Map<string, Promise<boolean>>();
	function isDirectory(path: string): Promise<boolean> {
		if (path === ".") return Promise.resolve(true);
		let result = dirs.get(path);
		if (!result) {
			result = isDirectory(dirname(path)).then(async (parent) => parent && (await lstat(join(root, path))).isDirectory())
				.catch((error) => { if (missing(error)) return false; throw error; });
			dirs.set(path, result);
		}
		return result;
	}
	return async (path: string): Promise<Blob | undefined> => {
		if (!(await isDirectory(dirname(path)))) return undefined;
		try {
			const full = join(root, path);
			const stat = await lstat(full);
			if (stat.isSymbolicLink()) {
				const target = await readlink(full, { encoding: "buffer" });
				return { mode: "120000", id: blobHash(algorithm, target.length).update(target).digest("hex"), size: target.length };
			}
			if (!stat.isFile()) return undefined;
			const hash = blobHash(algorithm, stat.size);
			for await (const chunk of createReadStream(full)) hash.update(chunk);
			return { mode: stat.mode & 0o100 ? "100755" : "100644", id: hash.digest("hex"), size: stat.size };
		} catch (error) {
			if (missing(error)) return undefined;
			throw error;
		}
	};
}

function text(buffer: Buffer): string | undefined {
	if (buffer.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
	} catch {
		return undefined;
	}
}

export async function readChanges(cwd: string): Promise<ChangesSnapshot> {
	const { root, kind } = repoRoot(cwd);
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
	const run = (command: string, args: string[]) => exec(command, args, { cwd: root, encoding: "buffer", maxBuffer: listLimit, env });
	let repoArgs: string[] = [];
	let base: string | undefined;
	let tracked: string[] = [];
	if (kind === "jj") {
		// Don't run a normal jj diff: it snapshots the working copy before reading.
		const jj = async (...args: string[]) => (await run("jj", ["--ignore-working-copy", "--at-op=@", "--no-pager", "--color=never", ...args])).stdout.toString();
		const [parents, gitDir, files] = await Promise.all([
			jj("log", "-r", "parents(@)", "--no-graph", "-T", 'commit_id ++ "\\n"'),
			jj("git", "root"),
			jj("file", "list", "-r", "@", "-T", 'path ++ "\\0"'),
		]);
		repoArgs = [`--git-dir=${gitDir.trimEnd()}`, `--work-tree=${root}`];
		const revisions = parents.trim().split(/\s+/).filter(Boolean);
		if (revisions.length > 1) throw new Error("A Jujutsu merge working copy requires a merged baseline; /changes does not snapshot or merge it.");
		base = revisions.find((id) => !/^0+$/.test(id));
		tracked = nulFields(files);
	}
	const git = async (...args: string[]) => (await run("git", [...repoArgs, ...args])).stdout;
	if (kind === "Git") {
		try {
			base = (await git("rev-parse", "--verify", "--quiet", "HEAD")).toString().trim();
		} catch (error) {
			if ((error as { code?: number }).code !== 1) throw error;
		}
	}
	const [objectFormat, tree, local] = await Promise.all([
		git("rev-parse", "--show-object-format"),
		base ? git("ls-tree", "-rlz", base) : Buffer.alloc(0),
		git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".",
			":(exclude,glob)**/.jj", ":(exclude,glob)**/.jj/**"),
	]);
	const old = new Map<string, Blob>();
	for (const item of nulFields(tree.toString())) {
		const tab = item.indexOf("\t");
		const [mode, , id, size] = item.slice(0, tab).trim().split(/\s+/);
		old.set(item.slice(tab + 1), { mode: mode!, id: id!, size: Number(size) });
	}
	const paths = [...new Set([...old.keys(), ...tracked, ...nulFields(local.toString())])].sort();
	const algorithm = objectFormat.toString().trim();
	const file = diskReader(root, algorithm);
	const entries: Change[] = [];
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(16, paths.length) }, async () => {
		while (next < paths.length) {
			const path = paths[next++]!;
			const before = old.get(path);
			// Gitlinks track a separate repository, not its local workings.
			if (before?.mode === "160000") continue;
			const after = await file(path);
			if (before?.id === after?.id && before?.mode === after?.mode) continue;
			let status: Change["status"] = "M";
			if (!before) status = "A";
			else if (!after) status = "D";
			entries.push({ path, before, after, status });
		}
	}));
	entries.sort((a, b) => a.path.localeCompare(b.path));
	return {
		kind, root, entries,
		async read(change) {
			if ([change.before, change.after].some((blob) => blob && blob.size > previewLimit)) return undefined;
			const current = await diskReader(root, algorithm)(change.path);
			if (current?.id !== change.after?.id || current?.mode !== change.after?.mode) {
				throw new Error("File changed since the list was loaded. Press r to refresh.");
			}
			const full = join(root, change.path);
			const readCurrent = async () => {
				if (!current) return Buffer.alloc(0);
				if (current.mode === "120000") return readlink(full, { encoding: "buffer" });
				return readFile(full);
			};
			const [before, after] = await Promise.all([
				change.before ? git("cat-file", "blob", change.before.id) : Buffer.alloc(0),
				readCurrent(),
			]);
			if (current && blobHash(algorithm, after.length).update(after).digest("hex") !== current.id) {
				throw new Error("File changed since the list was loaded. Press r to refresh.");
			}
			const a = text(before);
			const b = text(after);
			return a === undefined || b === undefined ? undefined : { before: a, after: b };
		},
	};
}
