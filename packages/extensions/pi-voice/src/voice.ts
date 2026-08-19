// pi-voice: dictation for pi, driven by `audiomemo record --stream`.
//
// Every decision about devices, backends, formats, and secrets stays in
// audiomemo, where it is already tested. This file owns the wire format, the
// configuration read out of the environment, and the two pieces of arithmetic
// that only a consumer can do: how wide a rendered row is, and how a raw mic
// reading becomes a bar that is pleasant to look at.
//
// It imports nothing at runtime. pi injects @earendil-works/pi-tui as a jiti
// virtual module (core/extensions/loader.ts), so an import would resolve when
// pi loads this file from a bare store path but not under `bun test` in the
// Nix check sandbox. Forty lines of width maths is what buys a test of the
// code that actually ships.

// ── The wire format ───────────────────────────────────────────────────────

export interface StartEvent {
	type: "start";
	t: number;
	device?: string;
	device_label?: string;
	devices?: string[];
	path?: string;
	format?: string;
	sample_rate?: number;
	channels?: number;
	mode: "live" | "batch" | "none";
	backend?: string;
}

export interface LevelEvent {
	type: "level";
	t: number;
	rms: number;
	db: number;
}

export interface TextEvent {
	type: "partial" | "commit";
	t: number;
	text: string;
}

export interface FinalEvent {
	type: "final";
	t: number;
	text: string;
	path?: string;
	transcript_path?: string;
	backend?: string;
	source: "live" | "batch";
}

export interface ErrorEvent {
	type: "error";
	t: number;
	scope: "record" | "stream" | "transcribe" | "config";
	fatal: boolean;
	message: string;
}

export interface EndEvent {
	type: "end";
	t: number;
	reason: "stopped" | "signal" | "error";
	path?: string;
	exit_code: number;
}

export type VoiceEvent = StartEvent | LevelEvent | TextEvent | FinalEvent | ErrorEvent | EndEvent;

const KNOWN_TYPES = new Set(["start", "level", "partial", "commit", "final", "error", "end"]);

/**
 * Parse one NDJSON line. Junk and unknown types return undefined rather than
 * throwing: a stray line must never take the session down, and the schema is
 * allowed to grow without this extension being rebuilt.
 */
export function parseEvent(line: string): VoiceEvent | undefined {
	const trimmed = line.trim();
	if (trimmed === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const type = (parsed as { type?: unknown }).type;
	if (typeof type !== "string" || !KNOWN_TYPES.has(type)) return undefined;
	return parsed as VoiceEvent;
}

/**
 * Reassemble whole lines from arbitrary stdout chunks. A pipe read can end
 * mid-object, and JSON.parse on half an object throws.
 */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
	let pending = "";
	return (chunk: string) => {
		pending += chunk;
		for (;;) {
			const idx = pending.indexOf("\n");
			if (idx < 0) break;
			const line = pending.slice(0, idx).replace(/\r$/, "");
			pending = pending.slice(idx + 1);
			if (line !== "") onLine(line);
		}
	};
}

// ── Configuration ─────────────────────────────────────────────────────────

export type VoicePlacement = "aboveEditor" | "belowEditor";

export interface VoiceConfig {
	recordBin: string;
	recordArgs: string[];
	barWidth: number;
	placement: VoicePlacement;
	mode: string;
}

/**
 * Read configuration from the environment. pi's ExtensionContext exposes no
 * settings reader, which is the same reason pi-auto-mode and pi-notify take
 * their config this way, so Nix hands values in as environment variables.
 */
export function readVoiceConfig(env: Record<string, string | undefined>): VoiceConfig {
	const extra = (env.PI_VOICE_RECORD_ARGS ?? "").trim();
	// -t is a default rather than an implication in audiomemo, so pi-voice asks
	// for it explicitly: without a batch pass, a run on a machine with no
	// realtime key records audio and produces no text at all.
	const recordArgs = ["--stream", "-t", ...(extra === "" ? [] : extra.split(/\s+/))];

	let barWidth = 12;
	const raw = env.PI_VOICE_BAR_WIDTH;
	if (raw !== undefined) {
		const n = Number.parseInt(raw, 10);
		if (Number.isFinite(n)) barWidth = Math.max(1, Math.min(64, n));
	}

	return {
		recordBin: env.PI_VOICE_RECORD_BIN ?? "record",
		recordArgs,
		barWidth,
		placement: env.PI_VOICE_PLACEMENT === "aboveEditor" ? "aboveEditor" : "belowEditor",
		mode: env.PI_VOICE_MODE ?? "toggle",
	};
}

// ── Width maths ───────────────────────────────────────────────────────────

// CSI sequences, which is all pi's theme emits: theme.fg produces
// `${sgr}${text}\x1b[39m`.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// East Asian Wide and Fullwidth ranges, plus the emoji blocks. Under-counting
// would let a row exceed the width pi handed us, which the differential
// renderer does not forgive; over-counting only truncates early.
const WIDE_RANGES: Array<[number, number]> = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f64f],
	[0x1f900, 0x1f9ff],
	[0x20000, 0x3fffd],
];

function charWidth(cp: number): number {
	for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return 2;
	return 1;
}

/** Visible width in terminal cells, ignoring SGR sequences. */
export function visibleWidth(s: string): number {
	let total = 0;
	for (const ch of s.replace(ANSI_RE, "")) total += charWidth(ch.codePointAt(0) ?? 0);
	return total;
}

/**
 * Truncate to a cell width, keeping escape sequences whole and appending a
 * reset whenever anything was cut, so a colour cannot leak into the next row.
 */
export function truncateToWidth(s: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(s) <= width) return s;

	let out = "";
	let used = 0;
	let i = 0;
	let sawEscape = false;
	while (i < s.length) {
		if (s[i] === "\x1b") {
			const m = /^\x1b\[[0-9;]*[A-Za-z]/.exec(s.slice(i));
			if (m) {
				out += m[0];
				i += m[0].length;
				sawEscape = true;
				continue;
			}
		}
		const cp = s.codePointAt(i) ?? 0;
		const ch = String.fromCodePoint(cp);
		const w = charWidth(cp);
		if (used + w > width) break;
		out += ch;
		used += w;
		i += ch.length;
	}
	// The reset is only needed when the cut happened after a colour was opened
	// and before its own terminator was reached. Appending it to plain text
	// would be bytes the terminal has to parse for no reason, and it would show
	// up in every assertion anyone ever writes against a truncated row.
	return sawEscape ? `${out}\x1b[0m` : out;
}

// ── Metering ──────────────────────────────────────────────────────────────

/**
 * The interval one attack or decay coefficient is stated against. audiomemo's
 * emitter coalesces levels into 50 ms windows, so this is the gap the wire was
 * designed around and the one that makes the coefficients below read as the
 * same numbers audiomemo's own VUMeter uses (internal/tui/vu.go).
 */
export const NOMINAL_FRAME_MS = 50;

const ATTACK_PER_FRAME = 0.5;
const DECAY_PER_FRAME = 0.15;

/**
 * Fast attack, slow decay. The wire carries raw readings; smoothing is a
 * rendering decision and belongs here.
 *
 * The coefficients are per unit of elapsed time rather than per reading. That
 * is not a refinement: audiomemo's 20 Hz throttle turns out to be inert on
 * real hardware, because ffmpeg's astats emits about 8 lines a second and the
 * gaps between them are ragged. Applying a fixed coefficient per arrival would
 * put the producer's jitter straight into the bar, so the coefficient is
 * rescaled by how long the reading actually took to show up.
 */
export class Meter {
	private smoothed = 0;

	push(level: number, dtMs: number = NOMINAL_FRAME_MS): void {
		const target = Math.max(0, Math.min(1, level));
		const frames = Math.max(0, dtMs) / NOMINAL_FRAME_MS;
		if (frames === 0) return;
		const perFrame = target > this.smoothed ? ATTACK_PER_FRAME : DECAY_PER_FRAME;
		// (1 - k) is the fraction of the gap that survives one nominal frame, so
		// raising it to the number of frames elapsed is the same exponential
		// sampled at an arbitrary interval. n frames of the old per-event rule
		// and one frame of n times the length now land on the same number.
		const alpha = 1 - (1 - perFrame) ** frames;
		this.smoothed += (target - this.smoothed) * alpha;
		this.smoothed = Math.max(0, Math.min(1, this.smoothed));
	}

	get level(): number {
		return this.smoothed;
	}
}
