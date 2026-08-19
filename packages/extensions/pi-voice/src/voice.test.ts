import { describe, expect, it } from "bun:test";

import {
	createLineSplitter,
	Meter,
	NOMINAL_FRAME_MS,
	parseEvent,
	readVoiceConfig,
	truncateToWidth,
	visibleWidth,
} from "./voice.ts";

describe("parseEvent", () => {
	it("reads every event type audiomemo emits", () => {
		expect(parseEvent('{"type":"start","t":0,"path":"/tmp/x.ogg","mode":"live"}')).toMatchObject({
			type: "start",
			path: "/tmp/x.ogg",
			mode: "live",
		});
		expect(parseEvent('{"type":"level","t":50,"rms":0.21,"db":-47.4}')).toMatchObject({
			type: "level",
			rms: 0.21,
			db: -47.4,
		});
		expect(parseEvent('{"type":"partial","t":900,"text":"so the"}')).toMatchObject({ type: "partial", text: "so the" });
		expect(parseEvent('{"type":"commit","t":1400,"text":"So the"}')).toMatchObject({ type: "commit", text: "So the" });
		expect(parseEvent('{"type":"final","t":9000,"text":"Done.","source":"batch"}')).toMatchObject({
			type: "final",
			text: "Done.",
			source: "batch",
		});
		expect(parseEvent('{"type":"error","t":1,"scope":"stream","fatal":false,"message":"nope"}')).toMatchObject({
			type: "error",
			scope: "stream",
			fatal: false,
		});
		expect(parseEvent('{"type":"end","t":9100,"reason":"signal","exit_code":0}')).toMatchObject({
			type: "end",
			reason: "signal",
		});
	});

	// A stray line must never take the session down with it.
	it("returns undefined rather than throwing on junk", () => {
		expect(parseEvent("not json")).toBeUndefined();
		expect(parseEvent("")).toBeUndefined();
		expect(parseEvent("   ")).toBeUndefined();
		expect(parseEvent("[1,2,3]")).toBeUndefined();
		expect(parseEvent('{"no":"type"}')).toBeUndefined();
	});

	// The schema is allowed to grow; unknown types are skipped, not fatal.
	it("skips event types it does not know", () => {
		expect(parseEvent('{"type":"device","t":0,"name":"mic"}')).toBeUndefined();
	});
});

describe("createLineSplitter", () => {
	it("reassembles objects split across chunk boundaries", () => {
		const lines: string[] = [];
		const feed = createLineSplitter((l) => lines.push(l));
		feed('{"type":"lev');
		feed('el","t":1}\n{"type":"par');
		feed('tial","t":2}\n');
		expect(lines).toEqual(['{"type":"level","t":1}', '{"type":"partial","t":2}']);
	});

	it("holds a trailing partial line until its newline arrives", () => {
		const lines: string[] = [];
		const feed = createLineSplitter((l) => lines.push(l));
		feed('{"a":1}\n{"b":2}');
		expect(lines).toEqual(['{"a":1}']);
		feed("\n");
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("tolerates CRLF", () => {
		const lines: string[] = [];
		const feed = createLineSplitter((l) => lines.push(l));
		feed('{"a":1}\r\n');
		expect(lines).toEqual(['{"a":1}']);
	});
});

describe("readVoiceConfig", () => {
	it("defaults to the record binary on PATH", () => {
		const cfg = readVoiceConfig({});
		expect(cfg.recordBin).toBe("record");
		expect(cfg.recordArgs).toEqual(["--stream", "-t"]);
		expect(cfg.barWidth).toBe(12);
		expect(cfg.placement).toBe("belowEditor");
	});

	// Nix passes an absolute store path so the jail does not have to guess.
	it("takes the binary and extra args from the environment", () => {
		const cfg = readVoiceConfig({
			PI_VOICE_RECORD_BIN: "/nix/store/abc-audiomemo/bin/record",
			PI_VOICE_RECORD_ARGS: "-D mic --temp",
		});
		expect(cfg.recordBin).toBe("/nix/store/abc-audiomemo/bin/record");
		expect(cfg.recordArgs).toEqual(["--stream", "-t", "-D", "mic", "--temp"]);
	});

	it("never lets a caller drop --stream", () => {
		const cfg = readVoiceConfig({ PI_VOICE_RECORD_ARGS: "--no-tui" });
		expect(cfg.recordArgs[0]).toBe("--stream");
	});

	it("reads the bar width and clamps nonsense", () => {
		expect(readVoiceConfig({ PI_VOICE_BAR_WIDTH: "20" }).barWidth).toBe(20);
		expect(readVoiceConfig({ PI_VOICE_BAR_WIDTH: "0" }).barWidth).toBe(1);
		expect(readVoiceConfig({ PI_VOICE_BAR_WIDTH: "nope" }).barWidth).toBe(12);
	});
});

describe("visibleWidth", () => {
	it("ignores SGR sequences", () => {
		expect(visibleWidth("\x1b[31mred\x1b[39m")).toBe(3);
	});

	it("counts East Asian wide characters as two cells", () => {
		expect(visibleWidth("日本語")).toBe(6);
		expect(visibleWidth("ab日")).toBe(4);
	});

	it("counts the block glyphs the meter draws as one cell each", () => {
		expect(visibleWidth("████░░░░")).toBe(8);
	});
});

describe("truncateToWidth", () => {
	it("leaves a string that already fits", () => {
		expect(truncateToWidth("hello", 10)).toBe("hello");
	});

	it("cuts to the requested width", () => {
		expect(truncateToWidth("hello world", 5)).toBe("hello");
	});

	// Cutting mid-sequence would leak an unterminated colour into the next row.
	it("keeps SGR sequences whole and resets at the cut", () => {
		const out = truncateToWidth("\x1b[31mhello world\x1b[39m", 5);
		expect(visibleWidth(out)).toBe(5);
		expect(out.endsWith("\x1b[0m")).toBe(true);
	});

	// The reset is repair work for a colour that was opened and never closed.
	// Plain text needs none, and emitting one anyway shows up in every
	// assertion anybody writes against a truncated row.
	it("adds no reset when there was no colour to leak", () => {
		expect(truncateToWidth("hello world", 5)).toBe("hello");
		expect(truncateToWidth("hello", 10)).not.toContain("\x1b");
	});

	it("never splits a wide character across the boundary", () => {
		const out = truncateToWidth("a日本", 2);
		expect(visibleWidth(out)).toBeLessThanOrEqual(2);
		expect(out.startsWith("a")).toBe(true);
	});
});

describe("Meter", () => {
	// Same attack and decay as audiomemo's TUI meter, so the mic feels the same
	// in pi as it does in `record`.
	it("rises fast and falls slow", () => {
		const m = new Meter();
		m.push(1, NOMINAL_FRAME_MS);
		expect(m.level).toBeCloseTo(0.5, 6);
		m.push(1, NOMINAL_FRAME_MS);
		expect(m.level).toBeCloseTo(0.75, 6);
		m.push(0, NOMINAL_FRAME_MS);
		expect(m.level).toBeCloseTo(0.6375, 6);
	});

	it("assumes one nominal frame when no interval is given", () => {
		const m = new Meter();
		m.push(1);
		expect(m.level).toBeCloseTo(0.5, 6);
	});

	it("stays inside 0..1", () => {
		const m = new Meter();
		for (let i = 0; i < 50; i++) m.push(5, NOMINAL_FRAME_MS);
		expect(m.level).toBeLessThanOrEqual(1);
		for (let i = 0; i < 200; i++) m.push(-5, NOMINAL_FRAME_MS);
		expect(m.level).toBeGreaterThanOrEqual(0);
	});

	// F807: audiomemo's 20 Hz throttle is inert on real hardware. astats emits
	// about 8 lines a second and the gaps are ragged (96 ms and 149 ms were both
	// measured), so a per-event coefficient makes the bar lurch by exactly as
	// much as the producer's jitter. The smoothing is therefore a function of
	// elapsed time, not of arrival count.
	it("reaches the same level whether the readings arrive in one gap or many", () => {
		const coarse = new Meter();
		coarse.push(1, 4 * NOMINAL_FRAME_MS);

		const fine = new Meter();
		for (let i = 0; i < 4; i++) fine.push(1, NOMINAL_FRAME_MS);

		expect(coarse.level).toBeCloseTo(fine.level, 9);
	});

	it("decays by elapsed time too, so a stalled producer does not freeze the bar", () => {
		const coarse = new Meter();
		const fine = new Meter();
		coarse.push(1, NOMINAL_FRAME_MS);
		fine.push(1, NOMINAL_FRAME_MS);

		coarse.push(0, 3 * NOMINAL_FRAME_MS);
		for (let i = 0; i < 3; i++) fine.push(0, NOMINAL_FRAME_MS);

		expect(coarse.level).toBeCloseTo(fine.level, 9);
	});

	it("treats a zero or negative interval as no elapsed time at all", () => {
		const m = new Meter();
		m.push(1, NOMINAL_FRAME_MS);
		const before = m.level;
		m.push(1, 0);
		m.push(1, -50);
		expect(m.level).toBeCloseTo(before, 9);
	});
});
