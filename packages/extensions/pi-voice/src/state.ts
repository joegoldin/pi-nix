// The voice state file, which is the piece that pays off twice.
//
// agent-statusline's `voice` widget does not read a bespoke file of its own. It
// reads Claude Code's layered settings and looks for a `voice` object
// (internal/voice/voice.go), taking the first layer that carries
// `voice.enabled`:
//
//   $CWD/.claude/settings.local.json
//   $CWD/.claude/settings.json
//   $DIR/settings.local.json
//   $DIR/settings.json          where $DIR is CLAUDE_CONFIG_DIR, else ~/.claude
//
// So the producer is simply whoever owns the microphone, and the contract is
// harness-independent: pi-voice writes this under pi, and anything driving
// Claude Code's dictation writes the same shape to the same place. One
// implementation lights the indicator in both.
//
// settings.local.json rather than settings.json: claude-nix places the latter
// and deep-merges it on every activation, so a producer writing there would be
// fighting the rebuild. settings.local.json is unmanaged.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface VoiceState {
	enabled: boolean;
	mode?: string;
	pid?: number;
	since?: number;
}

/**
 * Resolve the state file, mirroring internal/voice.NewReader: the
 * CLAUDE_CONFIG_DIR override when non-empty, otherwise $HOME/.claude.
 */
export function voiceStatePath(env: Record<string, string | undefined>, homeDir: string): string {
	const dir = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : join(homeDir, ".claude");
	return join(dir, "settings.local.json");
}

function readSettings(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		// Someone else's file that we cannot parse. Refuse rather than clobber.
		return undefined;
	}
}

/**
 * Set the voice block, preserving every other key. The write goes through a
 * temp file and a rename, because the reader can run at any moment and a torn
 * read makes the widget fall through to a lower settings layer rather than
 * failing visibly.
 */
export function writeVoiceState(path: string, state: VoiceState): void {
	const settings = readSettings(path);
	if (settings === undefined) return;

	const voice: Record<string, unknown> = { enabled: state.enabled };
	if (state.mode !== undefined) voice.mode = state.mode;
	if (state.pid !== undefined) voice.pid = state.pid;
	if (state.since !== undefined) voice.since = state.since;
	settings.voice = voice;

	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.pi-voice.tmp`;
	try {
		writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmpPath, path);
	} catch {
		try {
			unlinkSync(tmpPath);
		} catch {
			// The temp file was never created.
		}
	}
}

/**
 * Turn the indicator off. `enabled: false` rather than a deleted key: the
 * reader falls through when the key is absent, which would let a project-level
 * settings file answer instead and switch the indicator back on.
 */
export function clearVoiceState(path: string): void {
	if (!existsSync(path)) return;
	writeVoiceState(path, { enabled: false });
}

/**
 * Clear state left behind by a pi that died mid-recording. Without this the mic
 * glyph stays lit until the next successful stop, on a machine where nothing is
 * listening.
 *
 * State that names no pid is stale by construction: this writer always records
 * one, so an enabled block without it came from somewhere that cannot be asked
 * whether it is still running.
 */
export function reconcileStaleState(path: string, isAlive: (pid: number) => boolean): void {
	const settings = readSettings(path);
	if (!settings) return;
	const voice = settings.voice as VoiceState | undefined;
	if (!voice?.enabled) return;
	if (typeof voice.pid === "number" && isAlive(voice.pid)) return;
	writeVoiceState(path, { enabled: false });
}

/**
 * Default liveness probe. Signal 0 checks for the process without touching it;
 * EPERM means it exists and belongs to someone else.
 */
export function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}
