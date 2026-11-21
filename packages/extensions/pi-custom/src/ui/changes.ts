import { generateUnifiedPatch, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, sliceByColumn } from "@earendil-works/pi-tui";
import type { UiTheme } from "./card.ts";
import { changeKey, readChanges, type Change, type ChangesSnapshot } from "./changes-repo.ts";
import { Framed } from "./frame.ts";

const terminalText = (text: string) => text.replaceAll("\t", "    ").replace(/\p{Cc}/gu, "�");
type PatchRow = { text: string; line: number; hunk: boolean };

function patchRows(change: Change, contents: { before: string; after: string } | undefined): PatchRow[] {
	const rows: PatchRow[] = [];
	if (change.before && change.after && change.before.mode !== change.after.mode) {
		rows.push({ text: `Mode ${change.before.mode} → ${change.after.mode}`, line: 1, hunk: false });
	}
	if (!contents) return [...rows, { text: "Binary or too large to preview", line: 1, hunk: false }];
	const patch = generateUnifiedPatch(terminalText(change.path), contents.before, contents.after);
	let line = 1;
	const hunkStart = patch.indexOf("\n@@ ");
	if (hunkStart >= 0) {
		for (const text of patch.slice(hunkStart + 1).replace(/\n$/, "").split("\n")) {
			const hunk = /^@@ .* \+(\d+)/.exec(text);
			if (hunk) line = Number(hunk[1]);
			rows.push({ text, line: Math.max(1, line), hunk: !!hunk });
			if (text.startsWith("+") || text.startsWith(" ")) line++;
		}
	}
	if (rows.length === 0) rows.push({ text: "No text changes", line: 1, hunk: false });
	return rows;
}

export class ChangesView {
	private mode: "files" | "patch" | "source" = "files";
	private file = 0;
	private row = 0;
	private left = 0;
	private patchPosition = { row: 0, left: 0 };
	private pending = false;
	private closed = false;
	private error = "";
	private patch: PatchRow[] = [];
	private source?: string[];
	private readonly reviewed = new Set<string>();

	constructor(
		private snapshot: ChangesSnapshot,
		private readonly theme: UiTheme,
		private readonly height: () => number,
		private readonly reload: () => Promise<ChangesSnapshot>,
		private readonly repaint: () => void,
		private readonly done: () => void,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const { entries, kind } = this.snapshot;
		const change = entries[this.file];
		const count = entries.filter((item) => this.reviewed.has(changeKey(item))).length;
		const path = change ? terminalText(change.path) : "";
		const limit = Math.max(1, this.height() - 3);
		const lines = [`${kind} working copy · ${count}/${entries.length} reviewed`];
		const highlight = (text: string, selected: boolean) => selected ? this.theme.fg("accent", `› ${text}`) : `  ${text}`;
		if (this.mode === "files") {
			const top = Math.max(0, Math.min(this.file - Math.floor(limit / 2), entries.length - limit));
			for (const [i, entry] of entries.slice(top, top + limit).entries()) {
				const mark = this.reviewed.has(changeKey(entry)) ? "✓" : "·";
				lines.push(highlight(`${mark} ${entry.status}  ${terminalText(entry.path)}`, top + i === this.file));
			}
			if (!entries.length) lines.push("No working-copy changes.");
		} else {
			const isSource = this.mode === "source";
			lines[0] = isSource ? `${path}:${this.row + 1} · working file` : `${change?.status ?? ""} ${path}`;
			const total = isSource ? this.source?.length ?? 0 : this.patch.length;
			const top = Math.max(0, Math.min(this.row - Math.floor(limit / 2), total - limit));
			for (let row = top; row < Math.min(total, top + limit); row++) {
				const text = isSource ? `${row + 1}  ${this.source![row]}` : this.patch[row]!.text;
				let section = sliceByColumn(terminalText(text), this.left, Math.max(0, width - 2), true);
				if (!isSource && row !== this.row) {
					if (text.startsWith("+")) section = this.theme.fg("toolDiffAdded", section);
					else if (text.startsWith("-")) section = this.theme.fg("toolDiffRemoved", section);
				}
				lines.push(highlight(section, row === this.row));
			}
		}
		if (this.pending) lines.push(this.theme.fg("dim", "Reading…"));
		else if (this.error) lines.push(this.theme.fg("warning", terminalText(this.error)));
		let keys = "↑↓ PgUp/PgDn · Enter patch · Space review · r refresh · Esc close";
		if (this.mode === "patch") keys = "↑↓ scroll · n/p hunk · ←→ pan · o open line · Space review · Esc files";
		if (this.mode === "source") keys = "↑↓ PgUp/PgDn · ←→ pan · Esc patch";
		return [...lines, this.theme.fg("dim", keys)];
	}

	handleInput(data: string): void {
		if (this.closed || isKeyRelease(data)) return;
		const { entries } = this.snapshot;
		const current = entries[this.file];
		if (matchesKey(data, "ctrl+c") || (matchesKey(data, "escape") && this.mode === "files")) {
			this.closed = true;
			this.done();
			return;
		}
		if (this.pending) return;
		if (matchesKey(data, "escape")) {
			const fromSource = this.mode === "source";
			this.mode = fromSource ? "patch" : "files";
			this.row = fromSource ? this.patchPosition.row : 0;
			this.left = fromSource ? this.patchPosition.left : 0;
			this.error = "";
		} else if (matchesKey(data, "r")) {
			void this.load(async () => {
				this.snapshot = await this.reload();
				const selected = this.snapshot.entries.findIndex((entry) => entry.path === current?.path);
				this.file = Math.max(0, selected);
				this.mode = "files";
			});
		} else if (current && matchesKey(data, "space") && this.mode !== "source") {
			const key = changeKey(current);
			if (!this.reviewed.delete(key)) this.reviewed.add(key);
		} else if (current && matchesKey(data, "enter") && this.mode === "files") {
			void this.load(async () => {
				const contents = await this.snapshot.read(current);
				this.patch = patchRows(current, contents);
				this.source = current.after?.mode.startsWith("100") && contents ? contents.after.split("\n") : undefined;
				this.row = 0;
				this.left = 0;
				this.mode = "patch";
			});
		} else if (this.mode === "patch" && matchesKey(data, "o")) {
			if (this.source) {
				this.patchPosition = { row: this.row, left: this.left };
				this.error = "";
				this.mode = "source";
				this.row = Math.min(this.source.length - 1, this.patch[this.row]!.line - 1);
				this.left = 0;
			} else this.error = "No text working file to open.";
		} else if (this.mode === "patch" && (matchesKey(data, "n") || matchesKey(data, "p"))) {
			const target = matchesKey(data, "n")
				? this.patch.findIndex((row, i) => row.hunk && i > this.row)
				: this.patch.findLastIndex((row, i) => row.hunk && i < this.row);
			if (target >= 0) this.row = target;
		} else if (this.mode !== "files" && matchesKey(data, "left")) this.left = Math.max(0, this.left - 12);
		else if (this.mode !== "files" && matchesKey(data, "right")) this.left += 12;
		else {
			const page = Math.max(1, this.height() - 4);
			let delta = 0;
			if (matchesKey(data, "up")) delta = -1;
			if (matchesKey(data, "down")) delta = 1;
			if (matchesKey(data, "pageUp")) delta = -page;
			if (matchesKey(data, "pageDown")) delta = page;
			const clamp = (index: number, length: number) => Math.max(0, Math.min(length - 1, index + delta));
			if (this.mode === "files") this.file = clamp(this.file, entries.length);
			else this.row = clamp(this.row, this.mode === "source" ? this.source?.length ?? 0 : this.patch.length);
		}
		this.repaint();
	}

	private async load(action: () => Promise<void>): Promise<void> {
		this.pending = true;
		this.error = "";
		try {
			await action();
		} catch (error) {
			this.error = error instanceof Error ? error.message.split("\n", 1)[0]! : String(error);
		} finally {
			this.pending = false;
			if (!this.closed) this.repaint();
		}
	}
}

export function registerChanges(pi: ExtensionAPI): void {
	pi.registerCommand("changes", {
		description: "Review working-copy changes in Git or Jujutsu",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			const load = () => readChanges(ctx.cwd);
			try {
				const snapshot = await load();
				await ctx.ui.custom<void>((tui, theme, _keys, done) => {
					const view = new ChangesView(snapshot, theme, () => Math.floor(tui.terminal.rows * 0.6), load,
						() => tui.requestRender(), done);
					return new Framed(view, "Changes", theme);
				});
			} catch (error) {
				ctx.ui.notify(`/changes: ${terminalText(error instanceof Error ? error.message : String(error))}`, "error");
			}
		},
	});
}
