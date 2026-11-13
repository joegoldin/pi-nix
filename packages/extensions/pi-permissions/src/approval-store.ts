import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { approvalScope, type SavedCommandApproval } from "./denials.ts";
import { hash, safeDirectory } from "./directory-store.ts";
import { MAX_APPROVAL_SUMMARY } from "./auto/classifier.ts";


/**
 * Shell approvals the user chose to keep for later sessions started in one
 * launch folder. One file per scope, like folder grants, so concurrent
 * sessions cannot lose each other's updates. Only the user's own approval
 * prompt writes here; a record grants nothing by itself, it informs review.
 */
export class CommandApprovalStore {
	constructor(private readonly root: string) {}

	private folder(workspace: string): string {
		return join(this.root, hash(workspace));
	}

	private file(workspace: string, approval: Pick<SavedCommandApproval, "toolName" | "input" | "cwd">): string | undefined {
		const scope = approvalScope(approval.toolName, approval.input, approval.cwd);
		return scope?.scenario ? join(this.folder(workspace), `${hash(scope.key)}.json`) : undefined;
	}

	load(workspace: string): SavedCommandApproval[] {
		const approvals: SavedCommandApproval[] = [];
		try {
			if (!safeDirectory(this.root) || !safeDirectory(this.folder(workspace))) return approvals;
			for (const name of readdirSync(this.folder(workspace))) {
				if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
				try {
					const file = join(this.folder(workspace), name);
					const stat = lstatSync(file);
					if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size > 65_536 || (process.getuid && stat.uid !== process.getuid())) continue;
					const value = JSON.parse(readFileSync(file, "utf8"));
					if (value.version !== 1 || value.workspace !== workspace || !Number.isFinite(value.at) || value.at < 0) continue;
					if (value.toolName !== "bash" && value.toolName !== "bg_run") continue;
					if (!value.input || typeof value.input !== "object" || Array.isArray(value.input) || typeof value.input.command !== "string") continue;
					if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) continue;
					if (value.summary !== undefined && (typeof value.summary !== "string" || value.summary.length > MAX_APPROVAL_SUMMARY)) continue;
					const approval: SavedCommandApproval = { toolName: value.toolName, input: value.input, cwd: value.cwd, at: value.at, ...(value.summary ? { summary: value.summary } : {}) };
					// The name must match the content, so a renamed file cannot impersonate another scope.
					if (file !== this.file(workspace, approval)) continue;
					approvals.push(approval);
				} catch { /* Invalid or concurrently removed records grant nothing. */ }
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return approvals;
	}

	save(workspace: string, approval: Omit<SavedCommandApproval, "at">): void {
		const file = this.file(workspace, approval);
		if (!file) throw new Error("This approval has no reusable shell scope");
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		if (!safeDirectory(this.root)) throw new Error("Unsafe permission storage directory");
		mkdirSync(this.folder(workspace), { recursive: true, mode: 0o700 });
		if (!safeDirectory(this.folder(workspace))) throw new Error("Unsafe permission storage directory");
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify({ version: 1, workspace, ...approval, at: Date.now() }), { mode: 0o600, flag: "wx" });
			renameSync(temporary, file);
		} finally {
			try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}

	revoke(workspace: string, approval: Pick<SavedCommandApproval, "toolName" | "input" | "cwd">): void {
		const file = this.file(workspace, approval);
		if (!file) return;
		try {
			if (!safeDirectory(this.root) || !safeDirectory(this.folder(workspace))) throw new Error("Unsafe permission storage directory");
			unlinkSync(file);
		}
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
