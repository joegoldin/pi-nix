// The chord reader: a two-key sequence starting at ctrl+s, plus the standalone
// alt+i.
//
// pi's registerShortcut takes a single KeyId, and its KeybindingsManager
// resolves one key to one action, so neither can express "ctrl+s, then s".
// ctx.ui.onTerminalInput sees raw terminal bytes before the focused component
// does and can consume them (pi-tui's TUI.handleTerminalInput), which is the
// one surface a chord can be built on without replacing pi's editor.
//
// Matching is done here rather than through pi-tui's matchesKey because pi
// injects @earendil-works/pi-tui as a jiti virtual module: an import resolves
// when pi loads this file but not under `bun test`. The forms below are the
// ones pi-tui itself accepts for the handful of keys this extension binds.

/** Registers the append step can name: the ten numbered slots, or the stash. */
export type RegisterName = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "s";

export type ChordAction =
	| { kind: "stash" }
	| { kind: "undo" }
	| { kind: "redo" }
	| { kind: "copy" }
	| { kind: "cut" }
	| { kind: "thinking" }
	| { kind: "append"; register: RegisterName }
	| { kind: "tab" };

export interface ChordStep {
	/** True when the key belongs to the chord and must not reach the editor. */
	consume: boolean;
	/** True while the reader is waiting for a further key. */
	pending: boolean;
	action?: ChordAction;
}

/**
 * How long a half-typed chord survives. Long enough to be reachable with one
 * hand, short enough that a forgotten prefix does not swallow the next real
 * keystroke.
 */
export const CHORD_TIMEOUT_MS = 1500;

/** Caps Lock and Num Lock ride along in the Kitty modifier field. */
const LOCK_MASK = 64 + 128;

const MOD_SHIFT = 1;
const MOD_ALT = 2;
const MOD_CTRL = 4;

const CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;

interface ParsedKey {
	codepoint: number;
	modifier: number;
}

function parseCsiU(data: string): ParsedKey | undefined {
	const match = CSI_U.exec(data);
	if (!match) return undefined;
	const modifier = (match[4] ? Number.parseInt(match[4], 10) : 1) - 1;
	return { codepoint: Number.parseInt(match[1], 10), modifier: modifier & ~LOCK_MASK };
}

/** ctrl+letter, either as the C0 control character or as a CSI-u sequence. */
export function matchesCtrl(data: string, letter: string): boolean {
	const codepoint = letter.charCodeAt(0);
	if (data === String.fromCharCode(codepoint & 0x1f)) return true;
	const parsed = parseCsiU(data);
	return parsed !== undefined && parsed.codepoint === codepoint && parsed.modifier === MOD_CTRL;
}

/** alt+letter, either as ESC-prefixed or as a CSI-u sequence. */
export function matchesAlt(data: string, letter: string): boolean {
	if (data === `\x1b${letter}`) return true;
	const parsed = parseCsiU(data);
	return parsed !== undefined && parsed.codepoint === letter.charCodeAt(0) && parsed.modifier === MOD_ALT;
}

/**
 * The character an unmodified keypress carries, or undefined when the input is
 * anything else: a modified key, a control character, or a pasted run.
 */
export function printableKey(data: string): string | undefined {
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		return code >= 0x20 && code !== 0x7f ? data : undefined;
	}
	const parsed = parseCsiU(data);
	if (!parsed) return undefined;
	if ((parsed.modifier & ~MOD_SHIFT) !== 0) return undefined;
	return parsed.codepoint >= 0x20 && parsed.codepoint !== 0x7f ? String.fromCharCode(parsed.codepoint) : undefined;
}

/** ctrl+s, then one of these. */
const SECOND_KEY: Record<string, ChordAction> = {
	s: { kind: "stash" },
	u: { kind: "undo" },
	r: { kind: "redo" },
	y: { kind: "copy" },
	d: { kind: "cut" },
	t: { kind: "thinking" },
};

const REGISTERS = new Set<string>(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "s"]);

type State = "idle" | "prefix" | "append";

const IDLE: ChordStep = { consume: false, pending: false };
const WAITING: ChordStep = { consume: true, pending: true };
const CANCELLED: ChordStep = { consume: true, pending: false };

export class ChordReader {
	private state: State = "idle";
	private since = 0;

	get pending(): boolean {
		return this.state !== "idle";
	}

	cancel(): void {
		this.state = "idle";
	}

	feed(data: string, now: number): ChordStep {
		if (this.state !== "idle" && now - this.since > CHORD_TIMEOUT_MS) this.state = "idle";

		switch (this.state) {
			case "prefix": {
				const key = printableKey(data);
				if (key === "a") {
					this.state = "append";
					this.since = now;
					return WAITING;
				}
				this.state = "idle";
				const action = key === undefined ? undefined : SECOND_KEY[key];
				return action ? { consume: true, pending: false, action } : CANCELLED;
			}
			case "append": {
				this.state = "idle";
				const key = printableKey(data);
				if (key === undefined || !REGISTERS.has(key)) return CANCELLED;
				return { consume: true, pending: false, action: { kind: "append", register: key as RegisterName } };
			}
			default:
				if (matchesCtrl(data, "s")) {
					this.state = "prefix";
					this.since = now;
					return WAITING;
				}
				if (matchesAlt(data, "i")) return { consume: true, pending: false, action: { kind: "tab" } };
				return IDLE;
		}
	}
}
