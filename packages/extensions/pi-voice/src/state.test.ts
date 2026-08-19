import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearVoiceState, reconcileStaleState, voiceStatePath, writeVoiceState } from "./state.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "pi-voice-"));
}

describe("voiceStatePath", () => {
	// Must match agent-statusline's internal/voice.NewReader exactly:
	// CLAUDE_CONFIG_DIR when non-empty, otherwise $HOME/.claude.
	it("honours CLAUDE_CONFIG_DIR", () => {
		expect(voiceStatePath({ CLAUDE_CONFIG_DIR: "/etc/claude" }, "/home/joe")).toBe("/etc/claude/settings.local.json");
	});

	it("falls back to $HOME/.claude", () => {
		expect(voiceStatePath({}, "/home/joe")).toBe("/home/joe/.claude/settings.local.json");
	});

	it("treats an empty CLAUDE_CONFIG_DIR as unset, as the Go reader does", () => {
		expect(voiceStatePath({ CLAUDE_CONFIG_DIR: "" }, "/home/joe")).toBe("/home/joe/.claude/settings.local.json");
	});
});

describe("writeVoiceState", () => {
	it("creates the file and the directory when neither exists", () => {
		const dir = tmp();
		const path = join(dir, "nested", "settings.local.json");
		writeVoiceState(path, { enabled: true, mode: "toggle" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ voice: { enabled: true, mode: "toggle" } });
	});

	// settings.local.json legitimately holds other Claude Code settings.
	it("merges into an existing file without dropping other keys", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash(git log:*)"] }, theme: "dark" }));
		writeVoiceState(path, { enabled: true, mode: "toggle" });
		const got = JSON.parse(readFileSync(path, "utf8"));
		expect(got.permissions).toEqual({ allow: ["Bash(git log:*)"] });
		expect(got.theme).toBe("dark");
		expect(got.voice).toEqual({ enabled: true, mode: "toggle" });
	});

	it("replaces a previous voice block rather than merging into it", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		writeFileSync(path, JSON.stringify({ voice: { enabled: true, mode: "hold", pid: 42 } }));
		writeVoiceState(path, { enabled: false });
		expect(JSON.parse(readFileSync(path, "utf8")).voice).toEqual({ enabled: false });
	});

	// A file the producer cannot parse must not be destroyed; the producer is a
	// guest in someone else's settings file.
	it("leaves a malformed file alone", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		writeFileSync(path, "{not json");
		writeVoiceState(path, { enabled: true });
		expect(readFileSync(path, "utf8")).toBe("{not json");
	});

	it("records the pid so a crashed session can be reconciled", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		writeVoiceState(path, { enabled: true, mode: "toggle", pid: 4242 });
		expect(JSON.parse(readFileSync(path, "utf8")).voice.pid).toBe(4242);
	});

	it("writes through a temp file so a reader never sees a half-written object", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		writeVoiceState(path, { enabled: true });
		// The temp file must not survive the rename.
		expect(existsSync(`${path}.pi-voice.tmp`)).toBe(false);
	});
});

describe("clearVoiceState", () => {
	// false rather than absent: the reader falls through when the key is
	// missing, which would let a lower layer turn the indicator back on.
	it("sets enabled to false rather than deleting the key", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		writeVoiceState(path, { enabled: true, mode: "toggle" });
		clearVoiceState(path);
		expect(JSON.parse(readFileSync(path, "utf8")).voice).toEqual({ enabled: false });
	});

	it("does nothing when the file does not exist", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		clearVoiceState(path);
		expect(existsSync(path)).toBe(false);
	});
});

describe("reconcileStaleState", () => {
	// A crashed pi leaves enabled:true behind and the mic glyph stays lit
	// forever. On startup, a recorded pid that is gone means the state is stale.
	it("clears state left by a process that is gone", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		writeVoiceState(path, { enabled: true, mode: "toggle", pid: 999999 });
		reconcileStaleState(path, () => false);
		expect(JSON.parse(readFileSync(path, "utf8")).voice.enabled).toBe(false);
	});

	it("leaves state belonging to a live process alone", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		writeVoiceState(path, { enabled: true, mode: "toggle", pid: 4242 });
		reconcileStaleState(path, () => true);
		expect(JSON.parse(readFileSync(path, "utf8")).voice.enabled).toBe(true);
	});

	it("leaves a disabled state alone", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		writeVoiceState(path, { enabled: false });
		reconcileStaleState(path, () => false);
		expect(JSON.parse(readFileSync(path, "utf8")).voice).toEqual({ enabled: false });
	});

	// State with no pid at all cannot be attributed to a live process, so it is
	// stale by construction: an older producer wrote it, or the key was hand
	// edited. Leaving it lit would be the one failure this function exists for.
	it("clears state that names no process", () => {
		const dir = tmp();
		const path = join(dir, "settings.local.json");
		writeFileSync(path, JSON.stringify({ voice: { enabled: true, mode: "toggle" } }));
		reconcileStaleState(path, () => true);
		expect(JSON.parse(readFileSync(path, "utf8")).voice.enabled).toBe(false);
	});
});
