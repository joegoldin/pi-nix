import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import register, { type VoiceContext, VoiceSession } from "./index.ts";
import { writeVoiceState } from "./state.ts";

// bun's per-test timeout is 5s, below the waitFor deadline here. A cold run
// (bun's first transpile plus the first subprocess spawn) overshoots it and
// fails a test that is not actually slow. agent-statusline's suite hit this
// first.
setDefaultTimeout(30_000);

// bun:test has no vi.waitFor. Polls an assertion until it stops throwing. Same
// helper as agent-statusline/extension/statusline.test.ts.
async function waitFor(fn: () => unknown, timeoutMs = 10_000, stepMs = 10) {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	for (;;) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (Date.now() > deadline) throw lastErr;
			await new Promise((r) => setTimeout(r, stepMs));
		}
	}
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "pi-voice-"));
}

function voiceBlock(stateDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(stateDir, "settings.local.json"), "utf8")).voice;
}

/**
 * A stand-in for `record --stream`: prints canned NDJSON, then waits for SIGINT
 * and closes the stream the way audiomemo does. This is what makes the
 * controller testable without a microphone.
 */
function fakeRecordBin(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-voice-bin-"));
	const path = join(dir, "record");
	const final =
		'{\\"type\\":\\"final\\",\\"t\\":9000,\\"text\\":\\"So the thing is, we shipped it.\\",\\"path\\":\\"/tmp/x.ogg\\",\\"backend\\":\\"elevenlabs\\",\\"source\\":\\"batch\\"}';
	const end = '{\\"type\\":\\"end\\",\\"t\\":9010,\\"reason\\":\\"signal\\",\\"path\\":\\"/tmp/x.ogg\\",\\"exit_code\\":0}';
	writeFileSync(
		path,
		[
			"#!/bin/sh",
			// Installed before anything is printed. audiomemo arms its handler as
			// soon as the pipeline is up, and a toggle that stops almost at once
			// must still get a final rather than a killed shell.
			`trap 'printf "%s\\n" "${final}"; printf "%s\\n" "${end}"; exit 0' INT`,
			`printf '%s\\n' '{"type":"start","t":0,"device":"mic","device_label":"mic","devices":["mic"],"path":"/tmp/x.ogg","format":"ogg","sample_rate":48000,"channels":1,"mode":"live","backend":"elevenlabs"}'`,
			`printf '%s\\n' '{"type":"level","t":50,"rms":0.8,"db":-12}'`,
			`printf '%s\\n' '{"type":"partial","t":900,"text":"so the thing is"}'`,
			`printf '%s\\n' '{"type":"commit","t":1400,"text":"So the thing is,"}'`,
			// POSIX sh runs a trap only between commands, so the wait is sliced
			// rather than blocking on one long sleep.
			"while true; do sleep 0.05; done",
		].join("\n"),
	);
	chmodSync(path, 0o755);
	return path;
}

function fakePi() {
	const handlers = new Map<string, (payload: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	return {
		handlers,
		commands,
		on(event: string, handler: (payload: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand(
			name: string,
			options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
		) {
			commands.set(name, options);
		},
		emit(event: string, payload: unknown, ctx: unknown) {
			return handlers.get(event)?.(payload, ctx);
		},
	};
}

function fakeCtx(stateDir: string) {
	const widgets: Array<[string, unknown, unknown]> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const pastes: string[] = [];
	const notices: Array<[string, string | undefined]> = [];
	const theme = { fg: (slot: string, text: string) => `<${slot}>${text}</${slot}>` };
	const ctx: VoiceContext = {
		cwd: stateDir,
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget: (key: string, content: unknown, opts?: unknown) => {
				widgets.push([key, content, opts]);
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.push([key, text]);
			},
			pasteToEditor: (text: string) => {
				pastes.push(text);
			},
			notify: (message: string, type?: string) => {
				notices.push([message, type]);
			},
			theme,
		},
	};
	return { widgets, statuses, pastes, notices, theme, ctx };
}

describe("VoiceSession", () => {
	it("streams events into UI state and pastes the final text", async () => {
		const stateDir = tmp();
		process.env.PI_VOICE_RECORD_BIN = fakeRecordBin();
		process.env.CLAUDE_CONFIG_DIR = stateDir;
		try {
			const { ctx, pastes } = fakeCtx(stateDir);
			const session = new VoiceSession(ctx);

			session.start();
			await waitFor(() => expect(session.state.committed).toBe("So the thing is,"));
			expect(session.state.recording).toBe(true);
			// The commit that followed the partial settled it, so the moving text
			// is empty and the settled text carries the words.
			expect(session.state.partial).toBe("");
			expect(session.state.level).toBeGreaterThan(0);
			expect(session.state.db).toBe(-12);

			// The state file must be lit while the mic is live.
			expect(voiceBlock(stateDir)).toMatchObject({ enabled: true, mode: "toggle" });

			await session.stop();
			await waitFor(() => expect(pastes).toEqual(["So the thing is, we shipped it."]));
			expect(session.state.recording).toBe(false);
			expect(voiceBlock(stateDir).enabled).toBe(false);
		} finally {
			delete process.env.PI_VOICE_RECORD_BIN;
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});

	it("mounts a belowEditor widget and a sanitize-safe status token", async () => {
		const stateDir = tmp();
		process.env.PI_VOICE_RECORD_BIN = fakeRecordBin();
		process.env.CLAUDE_CONFIG_DIR = stateDir;
		try {
			const { ctx, widgets, statuses } = fakeCtx(stateDir);
			const session = new VoiceSession(ctx);
			session.start();
			await waitFor(() => expect(widgets.length).toBeGreaterThan(0));

			const [key, content, opts] = widgets[0];
			expect(key).toBe("pi-voice");
			// A component factory, not a string[]: the string[] form is wrapped in
			// Text with paddingX and capped at 10 lines, and this widget owns its
			// own width.
			expect(typeof content).toBe("function");
			expect(opts).toEqual({ placement: "belowEditor" });

			// setStatus runs text through sanitizeStatusText, which collapses runs
			// of spaces and newlines. The meter is space-padded, so only a short
			// token goes through it.
			const [, text] = statuses.at(-1) ?? [];
			expect(String(text)).not.toMatch(/ {2}/);
			expect(String(text)).not.toContain("\n");

			await session.stop();
		} finally {
			delete process.env.PI_VOICE_RECORD_BIN;
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});

	// A signal delivered before audiomemo has installed its handler lands on the
	// default disposition, which kills. The recording is then lost rather than
	// finished, and two quick toggles is how a user finds that out.
	it("holds the stop signal until the producer says it is up", async () => {
		const stateDir = tmp();
		process.env.PI_VOICE_RECORD_BIN = fakeRecordBin();
		process.env.CLAUDE_CONFIG_DIR = stateDir;
		try {
			const { ctx, pastes } = fakeCtx(stateDir);
			const session = new VoiceSession(ctx);
			session.start();
			// No await: the child has not run a single line yet.
			await session.stop();
			expect(pastes).toEqual(["So the thing is, we shipped it."]);
		} finally {
			delete process.env.PI_VOICE_RECORD_BIN;
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});

	it("surfaces a missing binary as a notice rather than an exception", async () => {
		const stateDir = tmp();
		process.env.PI_VOICE_RECORD_BIN = "/nonexistent/record";
		process.env.CLAUDE_CONFIG_DIR = stateDir;
		try {
			const { ctx, notices } = fakeCtx(stateDir);
			const session = new VoiceSession(ctx);
			session.start();
			await waitFor(() => expect(notices.length).toBe(1));
			expect(notices[0][1]).toBe("error");
			expect(session.state.recording).toBe(false);
			// A failed start must not leave the mic indicator lit.
			const p = join(stateDir, "settings.local.json");
			if (existsSync(p)) expect(voiceBlock(stateDir).enabled).toBe(false);
		} finally {
			delete process.env.PI_VOICE_RECORD_BIN;
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});

	// The Streamer's error events carry session failures that do not stop the
	// recording. They must reach the user as notices, not as stderr nobody sees.
	it("reports error events without stopping the recording", () => {
		const { ctx, notices } = fakeCtx(tmp());
		const session = new VoiceSession(ctx);
		session.handleEvent({
			type: "error",
			t: 1,
			scope: "stream",
			fatal: false,
			message: "elevenlabs error (rate_limited)",
		});
		expect(notices[0][1]).toBe("warning");
		expect(session.state.note).toContain("rate_limited");
	});

	it("says so when no transcription backend is available", () => {
		const { ctx } = fakeCtx(tmp());
		const session = new VoiceSession(ctx);
		session.handleEvent({ type: "start", t: 0, mode: "none", path: "/tmp/x.ogg" });
		expect(session.state.note).toContain("no transcription backend");
	});

	it("tells the user a batch run produces no partials", () => {
		const { ctx } = fakeCtx(tmp());
		const session = new VoiceSession(ctx);
		session.handleEvent({ type: "start", t: 0, mode: "batch", path: "/tmp/x.ogg" });
		expect(session.state.note).toContain("after recording");
	});

	// audiomemo stopped emitting an error event for --no-live-transcription: an
	// explicit opt-out is not a failure, and start.mode already says "none". So
	// the note is the only thing that ever explains a silent run, and nothing
	// here may wait for an error event to arrive first.
	it("explains a live-transcription opt-out from the start event alone", () => {
		const { ctx, notices } = fakeCtx(tmp());
		const session = new VoiceSession(ctx);
		session.handleEvent({ type: "start", t: 0, mode: "none", path: "/tmp/x.ogg" });
		expect(session.state.note).not.toBe("");
		expect(notices).toEqual([]);
	});

	it("does not paste an empty final", () => {
		const { ctx, pastes } = fakeCtx(tmp());
		const session = new VoiceSession(ctx);
		session.handleEvent({ type: "final", t: 1, text: "   ", source: "live" });
		expect(pastes).toEqual([]);
	});

	// Commits arrive one utterance at a time and the row shows all of them.
	it("appends commits and clears the partial they settled", () => {
		const { ctx } = fakeCtx(tmp());
		const session = new VoiceSession(ctx);
		session.handleEvent({ type: "partial", t: 1, text: "so the" });
		session.handleEvent({ type: "commit", t: 2, text: "So the thing is," });
		session.handleEvent({ type: "partial", t: 3, text: "we ship" });
		session.handleEvent({ type: "commit", t: 4, text: "we shipped it." });
		expect(session.state.committed).toBe("So the thing is, we shipped it.");
		expect(session.state.partial).toBe("");
	});
});

describe("extension entrypoint", () => {
	it("registers /voice and the lifecycle hooks pi publishes", () => {
		const pi = fakePi();
		register(pi);
		expect(pi.commands.has("voice")).toBe(true);
		expect(pi.commands.get("voice")?.description).toBeTruthy();
		for (const event of ["session_start", "session_shutdown"]) {
			expect(pi.handlers.has(event)).toBe(true);
		}
	});

	it("toggles: the first /voice starts, the second stops", async () => {
		const stateDir = tmp();
		process.env.PI_VOICE_RECORD_BIN = fakeRecordBin();
		process.env.CLAUDE_CONFIG_DIR = stateDir;
		try {
			const pi = fakePi();
			register(pi);
			const { ctx, pastes } = fakeCtx(stateDir);

			await pi.commands.get("voice")?.handler("", ctx);
			await waitFor(() => expect(voiceBlock(stateDir).enabled).toBe(true));

			await pi.commands.get("voice")?.handler("", ctx);
			await waitFor(() => expect(pastes.length).toBe(1));
		} finally {
			delete process.env.PI_VOICE_RECORD_BIN;
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});

	it("clears the mic indicator on shutdown", async () => {
		const stateDir = tmp();
		process.env.PI_VOICE_RECORD_BIN = fakeRecordBin();
		process.env.CLAUDE_CONFIG_DIR = stateDir;
		try {
			const pi = fakePi();
			register(pi);
			const { ctx } = fakeCtx(stateDir);
			await pi.commands.get("voice")?.handler("", ctx);
			await waitFor(() => expect(voiceBlock(stateDir).enabled).toBe(true));

			await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
			await waitFor(() => expect(voiceBlock(stateDir).enabled).toBe(false));
		} finally {
			delete process.env.PI_VOICE_RECORD_BIN;
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});

	it("clears state left behind by a crashed session on startup", async () => {
		const stateDir = tmp();
		process.env.CLAUDE_CONFIG_DIR = stateDir;
		try {
			writeVoiceState(join(stateDir, "settings.local.json"), { enabled: true, mode: "toggle", pid: 999999 });
			const pi = fakePi();
			register(pi);
			const { ctx } = fakeCtx(stateDir);
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			expect(voiceBlock(stateDir).enabled).toBe(false);
		} finally {
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});
});
