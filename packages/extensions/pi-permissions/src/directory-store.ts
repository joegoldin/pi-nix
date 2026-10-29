import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, isAbsolute, parse } from "node:path";
import { homedir } from "node:os";
import { resolvePathForPolicy } from "./auto/paths.ts";
import type { DirectoryAccess } from "./directory-access.ts";
import { DIRECTORY_ACCESS } from "./directory-proposal.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function safeDirectory(path: string): boolean {
	const stat = lstatSync(path);
	return stat.isDirectory() && (stat.mode & 0o022) === 0 && (!process.getuid || stat.uid === process.getuid());
}

/** Separate files avoid lost updates when sessions approve unrelated folders concurrently. */
export class DirectoryGrantStore {
	constructor(private readonly root: string) {}

	private folder(workspace: string): string {
		return join(this.root, hash(workspace));
	}

	private file(workspace: string, directory: DirectoryAccess): string {
		return join(this.folder(workspace), `${hash(JSON.stringify({ path: directory.path, access: directory.access }))}.json`);
	}

	load(workspace: string): { directory: DirectoryAccess; at: number }[] {
		const grants: { directory: DirectoryAccess; at: number }[] = [];
		try {
			if (!safeDirectory(this.root) || !safeDirectory(this.folder(workspace))) return grants;
			for (const name of readdirSync(this.folder(workspace))) {
				if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
				try {
					const file = join(this.folder(workspace), name);
					const stat = lstatSync(file);
					if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size > 16_384 || (process.getuid && stat.uid !== process.getuid())) continue;
					const value = JSON.parse(readFileSync(file, "utf8"));
					const directory = value.directory as DirectoryAccess;
					if (value.version !== 1 || value.workspace !== workspace || !Number.isFinite(value.at) || value.at < 0 || !directory || !DIRECTORY_ACCESS.includes(directory.access)) continue;
					if (typeof directory.path !== "string" || /[\u0000-\u001f\u007f]/.test(directory.path) || !isAbsolute(directory.path) || directory.path === parse(directory.path).root || directory.path === homedir()) continue;
					if (resolvePathForPolicy(directory.path) !== directory.path) continue;
					if (file !== this.file(workspace, directory)) continue;
					grants.push({ directory, at: value.at });
				} catch { /* Invalid or concurrently removed records grant nothing. */ }
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return grants;
	}

	save(workspace: string, directory: DirectoryAccess): void {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		if (!safeDirectory(this.root)) throw new Error("Unsafe permission storage directory");
		mkdirSync(this.folder(workspace), { recursive: true, mode: 0o700 });
		if (!safeDirectory(this.folder(workspace))) throw new Error("Unsafe permission storage directory");
		const file = this.file(workspace, directory);
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify({ version: 1, workspace, directory, at: Date.now() }), { mode: 0o600, flag: "wx" });
			renameSync(temporary, file);
		} finally {
			try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}

	revoke(workspace: string, directory: DirectoryAccess): void {
		try {
			if (!safeDirectory(this.root) || !safeDirectory(this.folder(workspace))) throw new Error("Unsafe permission storage directory");
			unlinkSync(this.file(workspace, directory));
		}
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
