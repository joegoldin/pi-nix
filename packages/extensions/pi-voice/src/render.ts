// Two rows below the editor: a meter row and a transcript row.
//
// pi hands the component a live theme proxy and pushes the render width on
// every frame (interactive-mode.ts), so colour and layout are decided here
// rather than upstream in Go. Colours are the theme's semantic slots, which
// follow the user's /theme choice; pi's own footer uses the same
// success/warning/error progression for its context meter.
//
// Layout is decided on plain text and the theme is applied afterwards, never
// the other way round. A theme is free to encode a colour however it likes,
// and measuring its output would make the row's width a property of the colour
// encoding. That is not hypothetical caution: it is what makes the fitting
// below testable against a recorder theme that emits readable tags instead of
// SGR bytes.

import { truncateToWidth, type VoiceConfig, visibleWidth } from "./voice.ts";

/** The subset of pi's Theme this extension uses, declared structurally so the
 *  tests can pass a recorder in place of the real proxy. */
export interface VoiceTheme {
	fg(slot: string, text: string): string;
	bold?(text: string): string;
}

export interface VoiceUiState {
	recording: boolean;
	elapsedMs: number;
	level: number;
	db: number;
	committed: string;
	partial: string;
	note: string;
}

export const FLOOR_DB = -60;

const SEPARATOR = " ";

/** A piece of a row: how many cells it will occupy, and how to colour it. */
interface Segment {
	width: number;
	render(theme: VoiceTheme): string;
}

function totalWidth(segments: Segment[]): number {
	if (segments.length === 0) return 0;
	return segments.reduce((n, s) => n + s.width, 0) + (segments.length - 1) * SEPARATOR.length;
}

/**
 * Drop segments from the right until the row fits. Dropping whole segments
 * rather than cutting the last one is what keeps a narrow terminal showing a
 * clock and a dot instead of half a bar.
 */
function fit(segments: Segment[], width: number, theme: VoiceTheme): string {
	const kept = [...segments];
	while (kept.length > 0 && totalWidth(kept) > width) kept.pop();
	return kept.map((s) => s.render(theme)).join(SEPARATOR);
}

function plain(text: string, slot: string): Segment {
	return { width: visibleWidth(text), render: (theme) => theme.fg(slot, text) };
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function levelSlot(level: number): string {
	if (level >= 0.85) return "error";
	if (level >= 0.6) return "warning";
	return "success";
}

/**
 * Keep the tail of a string, because that is where the speaker is. Leading
 * whitespace left behind by the cut is dropped so the row does not start with
 * a gap that looks like a rendering bug.
 */
function keepTail(text: string, width: number): string {
	if (width <= 0) return "";
	let out = text;
	while (out !== "" && visibleWidth(out) > width) out = out.slice(1);
	return out.replace(/^\s+/, "");
}

/** Row one: a record dot, the elapsed clock, the meter, and the dB readout. */
export function renderMeterRow(state: VoiceUiState, cfg: VoiceConfig, width: number, theme: VoiceTheme): string {
	if (!state.recording) {
		const note = truncateToWidth(state.note || "voice idle", width);
		return note === "" ? "" : theme.fg("dim", note);
	}

	const level = Math.max(0, Math.min(1, state.level));
	const filled = Math.round(level * cfg.barWidth);
	const bar: Segment = {
		width: cfg.barWidth,
		render: (t) => t.fg(levelSlot(level), "█".repeat(filled)) + t.fg("dim", "░".repeat(cfg.barWidth - filled)),
	};

	return fit(
		[
			plain("●", "error"),
			plain(formatElapsed(state.elapsedMs), "dim"),
			bar,
			plain(state.db <= FLOOR_DB ? "-inf dB" : `${state.db.toFixed(1)} dB`, "dim"),
		],
		width,
		theme,
	);
}

/**
 * Row two: committed text in the normal slot, the moving partial dimmed after
 * it. The partial is fitted first and the committed text takes what is left,
 * because the newest words are the ones the speaker is checking.
 */
export function renderTranscriptRow(state: VoiceUiState, width: number, theme: VoiceTheme): string {
	const committed = state.committed.trim();
	const partial = state.partial.trim();
	if (committed === "" && partial === "") {
		const placeholder = truncateToWidth("listening…", width);
		return placeholder === "" ? "" : theme.fg("dim", placeholder);
	}

	const shownPartial = keepTail(partial, width);
	const partialCost = shownPartial === "" ? 0 : visibleWidth(shownPartial) + SEPARATOR.length;
	const shownCommitted = keepTail(committed, width - partialCost);

	const pieces: string[] = [];
	if (shownCommitted !== "") pieces.push(theme.fg("text", shownCommitted));
	if (shownPartial !== "") pieces.push(theme.fg("dim", shownPartial));
	return pieces.join(SEPARATOR);
}

/**
 * The widget's whole output. An idle widget renders zero rows, which removes it
 * from the dock entirely rather than leaving a blank line behind. A note keeps
 * it alive after the meter has gone, which is how "transcribing after
 * recording" and a fatal error stay on screen.
 */
export function renderVoiceRows(
	state: VoiceUiState,
	cfg: VoiceConfig,
	width: number,
	theme: VoiceTheme,
): string[] {
	if (!state.recording && state.note === "") return [];
	return [renderMeterRow(state, cfg, width, theme), renderTranscriptRow(state, width, theme)];
}
