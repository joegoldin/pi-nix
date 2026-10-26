// pi-voice entrypoint: spawn `audiomemo record --stream`, render what it says,
// stream into the prompt editor, and tell the statusline the microphone is live.
//
// node's child_process rather than pi.exec: ExecOptions is { signal, timeout,
// cwd } and exec resolves once with the whole of stdout, so it cannot deliver
// partials as they arrive.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { homedir } from "node:os";
import type { Readable } from "node:stream";

import { VoiceGesture } from "./gesture.ts";
import { renderVoiceRows, type VoiceTheme, type VoiceUiState, FLOOR_DB } from "./render.ts";
import { clearVoiceState, pidIsAlive, reconcileStaleState, voiceStatePath, writeVoiceState } from "./state.ts";
import { createLineSplitter, Meter, parseEvent, readVoiceConfig, type VoiceConfig, type VoiceEvent } from "./voice.ts";

/** The slice of pi's ExtensionContext this extension touches. */
export interface VoiceContext {
	cwd: string;
	mode?: string;
	hasUI?: boolean;
	ui: {
		getEditorText?(): string;
		onEditorInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
		setWidget(key: string, content: unknown, options?: { placement?: string }): void;
		setStatus(key: string, text: string | undefined): void;
		pasteToEditor(text: string): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		readonly theme?: VoiceTheme;
	};
}

/** Optional handshake with pi-custom's existing prompt editor. */
export interface VoiceEditorRequest {
	accept(handle: {
		update(value: { committed: string; partial: string; level: number }): void;
		finish(text?: string): void;
	}): void;
	onInterrupt(): void;
}

/** The slice of pi's ExtensionAPI this extension registers against. */
export interface VoiceHost {
	events?: { emit(channel: string, data: unknown): void };
	on(event: string, handler: (payload: never, ctx: never) => unknown): void;
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: never) => Promise<void> },
	): void;
}

const WIDGET_KEY = "pi-voice";
const STATUS_KEY = "pi-voice";

/** pi calls requestRender at most once a frame, so a 1 Hz clock is free. */
const CLOCK_MS = 1000;

/**
 * How long a stop waits for the producer to announce itself before signalling
 * anyway. SIGINT's default disposition kills, so a signal that arrives before
 * audiomemo has installed its handler destroys the recording instead of
 * finishing it. Two toggles in quick succession is exactly how a user finds
 * that out.
 */
const STOP_GRACE_MS = 2000;

function emptyState(): VoiceUiState {
	return { recording: false, elapsedMs: 0, level: 0, db: FLOOR_DB, committed: "", partial: "", note: "" };
}

/** stdin is "ignore" and both output streams are pipes, which is exactly what
 *  spawn's overload returns for that stdio tuple. */
type RecordProcess = ChildProcessByStdio<null, Readable, Readable>;

function env(): Record<string, string | undefined> {
	return process.env as Record<string, string | undefined>;
}

export class VoiceSession {
	readonly state: VoiceUiState = emptyState();

	private readonly ctx: VoiceContext;
	private readonly cfg: VoiceConfig;
	private readonly statePath: string;
	private child: RecordProcess | undefined;
	private streamOpen = false;
	private stopRequested = false;
	private stopFallback: ReturnType<typeof setTimeout> | undefined;
	private meter = new Meter();
	private startedAt = 0;
	private lastLevelAt = 0;
	private tui: { requestRender(): void } | undefined;
	private clock: ReturnType<typeof setInterval> | undefined;
	private ended: (() => void) | undefined;
	private stopPromise: Promise<void> | undefined;
	private inline: Parameters<VoiceEditorRequest["accept"]>[0] | undefined;
	private usedInline = false;
	private finalHandled = false;

	constructor(ctx: VoiceContext, private readonly beginInline?: (request: VoiceEditorRequest) => void) {
		this.ctx = ctx;
		this.cfg = readVoiceConfig(env());
		this.statePath = voiceStatePath(env(), homedir());
	}

	get recording(): boolean {
		return this.state.recording;
	}

	get active(): boolean {
		return this.child !== undefined;
	}

	start(): void {
		if (this.child) return;

		this.meter = new Meter();
		this.streamOpen = false;
		this.stopRequested = false;
		this.usedInline = false;
		this.finalHandled = false;
		Object.assign(this.state, emptyState(), { recording: true });
		this.startedAt = Date.now();
		this.lastLevelAt = this.startedAt;

		let child: RecordProcess;
		try {
			child = spawn(this.cfg.recordBin, this.cfg.recordArgs, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			this.fail(err);
			return;
		}
		this.child = child;
		if (this.ctx.mode === "tui") {
			this.beginInline?.({
				accept: handle => { this.inline = handle; this.usedInline = true; },
				onInterrupt: () => { void this.stop(); },
			});
		}

		child.on("error", (err) => {
			this.fail(err);
		});

		const feed = createLineSplitter((line) => {
			const event = parseEvent(line);
			if (event) this.handleEvent(event);
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			feed(chunk);
		});

		// audiomemo's own warnings arrive as error events; fd 2 carries ffmpeg's
		// and whisper's diagnostics, which are not ours to reformat or to show.
		child.stderr.resume();

		child.on("close", () => {
			this.child = undefined;
			this.clearStopFallback();
			this.state.recording = false;
			this.stopClock();
			this.finishInline();
			clearVoiceState(this.statePath);
			this.paint();
			this.settle();
		});

		writeVoiceState(this.statePath, {
			enabled: true,
			mode: this.cfg.mode,
			pid: process.pid,
			since: this.startedAt,
		});
		if (!this.usedInline) {
			this.mountWidget();
			this.startClock();
		}
		this.paint();
	}

	/**
	 * Stop, and resolve once the child has closed, so the caller knows the final
	 * event has been handled and the editor has its final text.
	 */
	stop(): Promise<void> {
		if (!this.child) return Promise.resolve();
		if (this.stopPromise) return this.stopPromise;
		this.stopPromise = new Promise<void>((resolve) => {
			this.ended = resolve;
			this.stopRequested = true;
			if (this.streamOpen) {
				this.sendStop();
				return;
			}
			// The producer has not said it is up yet, so its signal handler may not
			// exist. Wait for the start event, but not indefinitely: a producer that
			// dies before announcing itself must still be stoppable.
			this.stopFallback ??= setTimeout(() => {
				this.sendStop();
			}, STOP_GRACE_MS);
			this.stopFallback.unref?.();
		});
		return this.stopPromise;
	}

	/** SIGINT, not SIGKILL: audiomemo's --stream handler stops ffmpeg the
	 *  graceful way, runs the batch pass, and emits final and end. */
	private sendStop(): void {
		this.clearStopFallback();
		this.child?.kill("SIGINT");
	}

	private clearStopFallback(): void {
		if (this.stopFallback) clearTimeout(this.stopFallback);
		this.stopFallback = undefined;
	}

	handleEvent(event: VoiceEvent): void {
		switch (event.type) {
			case "start":
				this.streamOpen = true;
				// audiomemo no longer reports a deliberate --no-live-transcription as
				// an error, so `mode` is the only thing that ever explains a run with
				// no live text. Saying nothing here would leave a silent transcript
				// row looking broken.
				this.state.note =
					event.mode === "none"
						? "no transcription backend configured; audio is still being recorded"
						: event.mode === "batch"
							? "transcribing after recording; no live text"
							: "";
				// A stop that arrived before the producer was up has been waiting for
				// exactly this line.
				if (this.stopRequested) this.sendStop();
				if (this.usedInline && this.state.note) this.ctx.ui.notify(`voice: ${this.state.note}`, "info");
				break;
			case "level": {
				const now = Date.now();
				this.meter.push(event.rms, now - this.lastLevelAt);
				this.lastLevelAt = now;
				this.state.level = this.meter.level;
				this.state.db = event.db;
				break;
			}
			case "partial":
				this.state.partial = event.text;
				break;
			case "commit":
				this.state.committed = this.state.committed === "" ? event.text : `${this.state.committed} ${event.text}`;
				this.state.partial = "";
				break;
			case "final": {
				if (this.finalHandled) break;
				this.finalHandled = true;
				const text = event.text.trim();
				if (this.usedInline) this.finishInline(text || undefined);
				else if (text !== "") this.ctx.ui.pasteToEditor(text);
				break;
			}
			case "error":
				this.state.note = event.message;
				this.ctx.ui.notify(`voice: ${event.message}`, event.fatal ? "error" : "warning");
				break;
			case "end":
				this.state.recording = false;
				break;
		}
		this.paint();
	}

	private finishInline(text?: string): void {
		const inline = this.inline;
		this.inline = undefined;
		inline?.finish(text);
	}

	private settle(): void {
		const done = this.ended;
		this.ended = undefined;
		this.stopPromise = undefined;
		done?.();
	}

	private fail(err: unknown): void {
		this.child = undefined;
		this.clearStopFallback();
		this.state.recording = false;
		this.stopClock();
		this.finishInline();
		clearVoiceState(this.statePath);
		this.ctx.ui.notify(`voice: could not start ${this.cfg.recordBin}: ${String(err)}`, "error");
		this.paint();
		this.settle();
	}

	private mountWidget(): void {
		// setWidget is stubbed headless and absent over RPC, so every UI call that
		// carries state is gated on being in a real TUI.
		if (this.ctx.mode !== "tui") return;
		this.ctx.ui.setWidget(
			WIDGET_KEY,
			(tui: { requestRender(): void }, theme: VoiceTheme) => {
				this.tui = tui;
				return {
					invalidate: () => {
						tui.requestRender();
					},
					dispose: () => {
						this.tui = undefined;
					},
					render: (width: number) => renderVoiceRows(this.state, this.cfg, width, theme),
				};
			},
			{ placement: this.cfg.placement },
		);
	}

	private startClock(): void {
		this.stopClock();
		// The elapsed clock has to advance without an inbound event.
		this.clock = setInterval(() => {
			this.state.elapsedMs = Date.now() - this.startedAt;
			this.tui?.requestRender();
		}, CLOCK_MS);
		// Never hold the process open for a clock that only draws a number.
		this.clock.unref?.();
	}

	private stopClock(): void {
		if (this.clock) clearInterval(this.clock);
		this.clock = undefined;
	}

	private paint(): void {
		this.inline?.update(this.state);
		// The custom editor owns both transcript and meter. Retain the widget
		// only for hosts without that integration, never alongside it.
		if (this.usedInline) {
			this.ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const theme = this.ctx.ui.theme;
		if (this.state.recording) {
			this.ctx.ui.setStatus(STATUS_KEY, theme ? theme.fg("error", "●rec") : "●rec");
		} else {
			this.ctx.ui.setStatus(STATUS_KEY, undefined);
			if (this.ctx.mode === "tui") this.ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		this.tui?.requestRender();
	}
}

export default function register(pi: VoiceHost): void {
	let session: VoiceSession | undefined;
	let unsubscribe: (() => void) | undefined;

	pi.on("session_start", (_payload: never, ctx: never) => {
		// A pi that died mid-recording leaves enabled:true behind and the mic
		// glyph stays lit. Clear it when the process that wrote it is gone.
		reconcileStaleState(voiceStatePath(env(), homedir()), pidIsAlive);
		session ??= new VoiceSession(ctx as VoiceContext, request => pi.events?.emit("pi-voice:begin", request));
		unsubscribe?.();
		unsubscribe = undefined;
		const context = ctx as VoiceContext;
		const { ui } = context;
		if (context.mode !== "tui" || !ui.onEditorInput || !ui.getEditorText) return;
		const gesture = new VoiceGesture();
		unsubscribe = ui.onEditorInput((data) => {
			const action = gesture.feed(data, ui.getEditorText!(), session?.active ?? false);
			if (!action) return;
			if (action === "start") {
				session?.start();
			} else if (action === "stop") {
				void session?.stop();
			}
			return { consume: true };
		});
	});

	pi.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
		await session?.stop();
		clearVoiceState(voiceStatePath(env(), homedir()));
	});

	pi.registerCommand("voice", {
		description: "Toggle dictation, or press Space in an empty prompt to start and Space to stop. Speech appears live in the editor; stopping never submits.",
		handler: async (_args: string, ctx: never) => {
			session ??= new VoiceSession(ctx as VoiceContext, request => pi.events?.emit("pi-voice:begin", request));
			if (session.active) {
				await session.stop();
			} else {
				session.start();
			}
		},
	});
}
