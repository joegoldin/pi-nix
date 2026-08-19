// The prompt stash: drafts the user set aside, and the registers that read them
// back.
//
// One list backs both. Register N is the Nth newest entry and the stash
// register is the newest, so the overlay, the restore chord, and the append
// chord all describe the same ten strings rather than three stores that can
// disagree about what "the last thing I stashed" means.
//
// Persistence is best-effort by design. The agent dir can be read-only (a
// container with the config bind-mounted, a sandbox that forgot the write
// permission), and losing the stash between sessions is a smaller failure than
// losing the extension.

import type { RegisterName } from "./chord.ts";

/** Ten entries, because there are ten numbered registers to read them with. */
export const MAX_STASH = 10;

const FILE_VERSION = 1;

export interface StashIO {
	read(): string;
	write(data: string): void;
}

/**
 * Resolve the stash file, mirroring pi's own PI_CODING_AGENT_DIR handling: the
 * override when non-empty, with a leading tilde expanded, otherwise
 * $HOME/.pi/agent.
 */
export function stashPath(env: Record<string, string | undefined>, homeDir: string): string {
	const override = env.PI_CODING_AGENT_DIR;
	const expanded = override?.startsWith("~/") ? `${homeDir}/${override.slice(2)}` : override;
	const dir = expanded ? expanded : `${homeDir}/.pi/agent`;
	return `${dir}/pi-extras/stash.json`;
}

function parseEntries(raw: string): string[] {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
	const entries = (parsed as { entries?: unknown }).entries;
	if (!Array.isArray(entries)) return [];
	return entries.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_STASH);
}

export class StashStore {
	private entries: string[] = [];
	private io: StashIO | undefined;

	constructor(io: StashIO | undefined) {
		this.io = io;
		if (!io) return;
		try {
			this.entries = parseEntries(io.read());
		} catch {
			// No file yet, or one this version cannot read. Either way the
			// session starts with an empty stash and may still write.
			this.entries = [];
		}
	}

	/** False once the stash is memory-only, which the overlay reports. */
	get persistent(): boolean {
		return this.io !== undefined;
	}

	list(): readonly string[] {
		return this.entries;
	}

	push(text: string): void {
		if (text.trim() === "") return;
		if (this.entries[0] === text) return;
		this.entries.unshift(text);
		if (this.entries.length > MAX_STASH) this.entries.length = MAX_STASH;
		this.save();
	}

	/** Take an entry out of the stash and return it. */
	restore(index = 0): string | undefined {
		const [entry] = this.entries.splice(index, 1);
		if (entry === undefined) return undefined;
		this.save();
		return entry;
	}

	/** Read a register without consuming it. */
	register(name: RegisterName): string | undefined {
		return this.entries[name === "s" ? 0 : Number.parseInt(name, 10)];
	}

	remove(index: number): void {
		if (index < 0 || index >= this.entries.length) return;
		this.entries.splice(index, 1);
		this.save();
	}

	clear(): void {
		this.entries = [];
		this.save();
	}

	private save(): void {
		if (!this.io) return;
		try {
			this.io.write(JSON.stringify({ version: FILE_VERSION, entries: this.entries }));
		} catch {
			// Dropping the io is what makes this a one-shot degradation rather
			// than a failed write on every keystroke for the rest of the session.
			this.io = undefined;
		}
	}
}
