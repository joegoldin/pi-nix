import { describe, expect, it } from "bun:test";

import { formatElapsed, renderMeterRow, renderTranscriptRow, renderVoiceRows, type VoiceUiState } from "./render.ts";
import { readVoiceConfig, visibleWidth } from "./voice.ts";

// A stand-in for pi's live theme proxy. Colours are recorded as
// <slot>{...}</slot> so tests assert on which semantic slot was chosen rather
// than on ANSI bytes, which is the whole point of going through the theme.
const theme = {
	fg: (slot: string, text: string) => `<${slot}>${text}</${slot}>`,
	bold: (text: string) => `<b>${text}</b>`,
};

const cfg = readVoiceConfig({});

// The real theme wraps text in SGR sequences, which visibleWidth already
// discounts. This recorder wraps it in tags instead, so every width assertion
// strips them first: measuring the recorder's own markup would measure the test
// harness rather than the row.
function bare(s: string): string {
	return s.replace(/<\/?[a-zA-Z]+>/g, "");
}

const base: VoiceUiState = {
	recording: true,
	elapsedMs: 12_000,
	level: 0.5,
	db: -30,
	committed: "",
	partial: "",
	note: "",
};

describe("formatElapsed", () => {
	it("counts in minutes and seconds", () => {
		expect(formatElapsed(0)).toBe("0:00");
		expect(formatElapsed(9_000)).toBe("0:09");
		expect(formatElapsed(72_000)).toBe("1:12");
		expect(formatElapsed(3_601_000)).toBe("60:01");
	});
});

describe("renderMeterRow", () => {
	it("shows a record dot, the clock, a bar, and a dB readout", () => {
		const row = bare(renderMeterRow(base, cfg, 60, theme));
		expect(row).toContain("0:12");
		expect(row).toContain("-30.0 dB");
		expect(row).toContain("█");
	});

	it("fills the bar in proportion to the level", () => {
		const quiet = bare(renderMeterRow({ ...base, level: 0 }, cfg, 60, theme));
		const loud = bare(renderMeterRow({ ...base, level: 1 }, cfg, 60, theme));
		expect((quiet.match(/█/g) ?? []).length).toBe(0);
		expect((loud.match(/█/g) ?? []).length).toBe(cfg.barWidth);
	});

	// The same thresholds audiomemo's TUI uses, expressed as pi's semantic
	// colour slots rather than as hardcoded RGB.
	it("colours the bar by level using theme slots", () => {
		expect(renderMeterRow({ ...base, level: 0.3 }, cfg, 60, theme)).toContain("<success>");
		expect(renderMeterRow({ ...base, level: 0.7 }, cfg, 60, theme)).toContain("<warning>");
		expect(renderMeterRow({ ...base, level: 0.9 }, cfg, 60, theme)).toContain("<error>");
	});

	it("shows silence as -inf rather than a wrong number", () => {
		expect(bare(renderMeterRow({ ...base, level: 0, db: -60 }, cfg, 60, theme))).toContain("-inf dB");
	});

	it("never exceeds the width it was given", () => {
		for (const w of [8, 20, 40, 120]) {
			expect(visibleWidth(bare(renderMeterRow(base, cfg, w, theme)))).toBeLessThanOrEqual(w);
		}
	});

	it("reports the note instead of a meter when not recording", () => {
		const row = bare(renderMeterRow({ ...base, recording: false, note: "transcribing…" }, cfg, 60, theme));
		expect(row).toContain("transcribing…");
		expect(row).not.toContain("█");
	});

	// The note is the only place a stream error is visible after a fatal stop,
	// and audiomemo's messages are longer than a narrow terminal.
	it("truncates a long note rather than overflowing the row", () => {
		const long = "elevenlabs error (rate_limited): ".repeat(6);
		const row = renderMeterRow({ ...base, recording: false, note: long }, cfg, 24, theme);
		expect(visibleWidth(bare(row))).toBeLessThanOrEqual(24);
	});
});

describe("renderTranscriptRow", () => {
	const quiet: VoiceUiState = { ...base, elapsedMs: 0, level: 0, db: -60 };

	it("puts committed text and the current partial on one line", () => {
		const row = renderTranscriptRow({ ...quiet, committed: "So the thing is,", partial: "we shipped" }, 80, theme);
		expect(bare(row)).toBe("So the thing is, we shipped");
	});

	// Committed text is settled, the partial is still moving; the theme's dim
	// slot is what tells them apart, exactly as audiomemo's TUI does.
	it("dims the partial and leaves committed text in the normal slot", () => {
		const row = renderTranscriptRow({ ...quiet, committed: "So the", partial: "thing" }, 80, theme);
		expect(row).toContain("<text>So the</text>");
		expect(row).toContain("<dim>thing</dim>");
	});

	// The transcript grows without bound; the row shows the end of it because
	// that is where the user is speaking.
	it("keeps the tail when the text is longer than the row", () => {
		const long = "word ".repeat(60).trim();
		const row = bare(renderTranscriptRow({ ...quiet, committed: long }, 20, theme));
		expect(visibleWidth(row)).toBeLessThanOrEqual(20);
		expect(row.endsWith("word")).toBe(true);
	});

	// A partial longer than the row must not push the committed text off and
	// then overflow anyway; the newest words win, which are its own tail.
	it("keeps the tail of an over-long partial", () => {
		const long = "and then ".repeat(30).trim();
		const row = renderTranscriptRow({ ...quiet, committed: "settled", partial: long }, 20, theme);
		expect(visibleWidth(bare(row))).toBeLessThanOrEqual(20);
		expect(bare(row).endsWith("then")).toBe(true);
	});

	it("shows a placeholder before any text has arrived", () => {
		expect(bare(renderTranscriptRow(quiet, 40, theme))).toContain("listening");
	});

	it("never exceeds the width it was given", () => {
		const st = { ...quiet, committed: "日本語のテスト".repeat(10) };
		for (const w of [6, 15, 31, 80]) {
			expect(visibleWidth(bare(renderTranscriptRow(st, w, theme)))).toBeLessThanOrEqual(w);
		}
	});
});

describe("renderVoiceRows", () => {
	it("returns nothing at all when idle", () => {
		const idle: VoiceUiState = { ...base, recording: false, elapsedMs: 0, level: 0, db: -60 };
		expect(renderVoiceRows(idle, cfg, 80, theme)).toEqual([]);
	});

	it("returns exactly two rows while recording", () => {
		const st: VoiceUiState = { ...base, elapsedMs: 1000, level: 0.4, db: -36, committed: "hi" };
		expect(renderVoiceRows(st, cfg, 80, theme)).toHaveLength(2);
	});

	// A note outlives the recording: it is how "transcribing after recording"
	// and a fatal error stay on screen after the meter has gone.
	it("keeps rendering while a note is outstanding", () => {
		const st: VoiceUiState = { ...base, recording: false, note: "transcribing…" };
		expect(renderVoiceRows(st, cfg, 80, theme)).toHaveLength(2);
	});
});
