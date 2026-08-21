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
	/** Which key the reader is waiting for, for the caller to prompt with. */
	stage?: "prefix" | "append";
	action?: ChordAction;
}

/**
 * How long a half-typed chord survives.
 *
 * This was 1500ms and that was too short to be usable. A chord nobody can see
 * has to be recalled from memory, and 1.5s is under the time it takes to
 * remember which letter you wanted -- press ctrl+s, pause to think, press `s`,
 * and the prefix has already expired, so the `s` lands in the prompt and the
 * feature reads as broken. Measured against the real TUI: the same two
 * keystrokes open the stash at a 1.2s gap and type an `s` at 2.0s.
 *
 * The window is now long enough to think in, and the caller prompts on screen
 * while it is open, so a forgotten prefix is visible rather than silent.
 */
export const CHORD_TIMEOUT_MS = 5000;

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

/**
 * Whether the sequence is a key RELEASE rather than a press.
 *
 * pi asks the terminal for Kitty keyboard protocol flags 7, and flag 2 is
 * "report event types", so a terminal that honours it sends a release for every
 * press. The event type rides in the field after the modifier -- 1 press,
 * 2 repeat, 3 release -- and parseCsiU captures that field and then ignores it,
 * which is how one physical ctrl+s used to fire twice.
 *
 * Worse than twice: the release is not always reported with the modifier still
 * held. `\x1b[115;1:3u` is the release of `s` with no modifiers, which
 * printableKey reads as a plain `s`, which SECOND_KEY reads as "stash". Press
 * ctrl+s and the chord opened and immediately completed itself.
 *
 * The set of terminators matches pi-tui's own isKeyRelease (keys.ts), which
 * cannot be imported here: pi injects that package as a jiti virtual module, so
 * an import resolves under pi and not under `bun test`.
 */
export function isKeyRelease(data: string): boolean {
	// Pasted text is not a key event, and can contain anything -- a MAC address
	// like "90:62:3F:A5" would otherwise read as a release. pi-tui guards the
	// same case the same way.
	if (data.includes("\x1b[200~")) return false;
	return /:3[u~ABCDHF]/.test(data);
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

/** The second keys the reader accepts, for the on-screen prompt to name. */
export const SECOND_KEY_LETTERS: readonly string[] = Object.keys(SECOND_KEY).concat("a");

type State = "idle" | "prefix" | "append";

const IDLE: ChordStep = { consume: false, pending: false };
const WAITING_PREFIX: ChordStep = { consume: true, pending: true, stage: "prefix" };
const WAITING_APPEND: ChordStep = { consume: true, pending: true, stage: "append" };
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

	/** A key that is not ours: passed to whoever is focused, without disturbing
	 *  a chord already in progress. `pending` still reports the reader's state,
	 *  so the caller does not take the menu down over a key it ignored. */
	private passthrough(): ChordStep {
		if (this.state === "idle") return IDLE;
		return { consume: false, pending: true, stage: this.state === "append" ? "append" : "prefix" };
	}

	feed(data: string, now: number): ChordStep {
		// Releases decide nothing. Every chord key is claimed on its press, and
		// acting on the release too is how ctrl+s used to stash by itself.
		if (isKeyRelease(data)) return this.passthrough();
		if (this.state !== "idle" && now - this.since > CHORD_TIMEOUT_MS) this.state = "idle";

		switch (this.state) {
			case "prefix": {
				// The prefix toggles: pressing it again on an open chord closes
				// it. Same key in, same key out, and the menu names esc for the
				// same job.
				//
				// It restarted the chord for one build, which was a fix for the
				// wrong problem: a repeated prefix looked like something the
				// reader had to tolerate because key releases were arriving as
				// phantom presses. Releases are ignored now, so a second ctrl+s
				// is a person pressing it.
				if (matchesCtrl(data, "s")) {
					this.state = "idle";
					return CANCELLED;
				}
				const key = printableKey(data);
				if (key === "a") {
					this.state = "append";
					this.since = now;
					return WAITING_APPEND;
				}
				this.state = "idle";
				const action = key === undefined ? undefined : SECOND_KEY[key];
				return action ? { consume: true, pending: false, action } : CANCELLED;
			}
			case "append": {
				// Closes from here too, rather than stepping back to the prefix:
				// the key means "put this away" wherever the chord has got to.
				if (matchesCtrl(data, "s")) {
					this.state = "idle";
					return CANCELLED;
				}
				this.state = "idle";
				const key = printableKey(data);
				if (key === undefined || !REGISTERS.has(key)) return CANCELLED;
				return { consume: true, pending: false, action: { kind: "append", register: key as RegisterName } };
			}
			default:
				if (matchesCtrl(data, "s")) {
					this.state = "prefix";
					this.since = now;
					return WAITING_PREFIX;
				}
				if (matchesAlt(data, "i")) return { consume: true, pending: false, action: { kind: "tab" } };
				return IDLE;
		}
	}
}
