// pi-extras entrypoint: the prompt stash, the ctrl+s chords that drive it, and
// the four session commands that go with them.
//
// Everything the extension does is optional to the session. pi runs in four
// modes and only "tui" has an editor, a terminal title, or raw input to
// intercept, so each surface is reached defensively: a missing one costs the
// feature that uses it and nothing else.
//
// There is deliberately no footer or status line here. agent-statusline owns
// the footer in this setup, and a second writer would fight it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { type ChordAction, ChordReader, type RegisterName } from "./chord.ts";
import {
	type ClipboardRunner,
	type ClipboardTarget,
	clipboardTargets,
	copyToClipboard,
	spawnRunner,
} from "./clipboard.ts";
import { gitEditorOverrides } from "./gitenv.ts";
import { expandPathRefs, nextThinkingLevel, unresolvedRefs } from "./input.ts";
import { type StashTheme, createStashComponent } from "./overlay.ts";
import { type StashIO, StashStore, stashPath } from "./stash.ts";
import { hintRows } from "./hint.ts";
import { TitleSpinner, baseTitle } from "./title.ts";
import { UndoBuffer } from "./undo.ts";

/** The slice of pi's ExtensionContext this extension touches. Every member the
 *  non-interactive modes stub away is optional. */
export interface ExtrasContext {
	cwd: string;
	mode?: string;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		getEditorText?(): string;
		setEditorText?(text: string): void;
		pasteToEditor?(text: string): void;
		setTitle?(title: string): void;
		setWidget?(key: string, content: string[] | undefined, options?: { placement?: string }): void;
		onTerminalInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
		custom?<T>(
			factory: (
				tui: { requestRender(): void },
				theme: StashTheme,
				keybindings: unknown,
				done: (result: T) => void,
			) => unknown,
			options?: { overlay?: boolean; overlayOptions?: unknown },
		): Promise<T>;
		readonly theme?: StashTheme;
	};
	sessionManager?: {
		getSessionName?(): string | undefined;
		getLeafId?(): string | null;
	};
	shutdown?(): void;
	newSession?(options?: unknown): Promise<{ cancelled: boolean }>;
	fork?(entryId: string, options?: { position?: "before" | "at" }): Promise<{ cancelled: boolean }>;
}

/** The slice of pi's ExtensionAPI this extension registers against. */
export interface ExtrasHost {
	on(event: string, handler: (payload: never, ctx: never) => unknown): void;
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: never) => Promise<void> },
	): void;
	getThinkingLevel?(): string;
	setThinkingLevel?(level: string): void;
}

/** Everything that touches the world, so the core can be tested without one. */
export interface ExtrasDeps {
	env: Record<string, string | undefined>;
	homeDir: string;
	now(): number;
	exists(path: string): boolean;
	clipboard: ClipboardTarget[];
	runClipboard: ClipboardRunner;
	applyEnv(values: Record<string, string>): void;
	stashIO: StashIO | undefined;
}

const NOTIFY_PREFIX = "pi-extras";

/** A draft appended to a prompt that is already there starts its own line. */
function appended(current: string, addition: string): string {
	if (current === "") return addition;
	return /\s$/.test(current) ? `${current}${addition}` : `${current}\n${addition}`;
}

export class ExtrasSession {
	readonly stash: StashStore;
	readonly undo = new UndoBuffer();

	private readonly pi: ExtrasHost;
	private readonly ctx: ExtrasContext;
	private readonly deps: ExtrasDeps;
	private readonly chord = new ChordReader();
	private readonly spinner: TitleSpinner;
	private unsubscribe: (() => void) | undefined;
	private inflight: Promise<void> = Promise.resolve();

	constructor(pi: ExtrasHost, ctx: ExtrasContext, deps: ExtrasDeps) {
		this.pi = pi;
		this.ctx = ctx;
		this.deps = deps;
		this.stash = new StashStore(deps.stashIO);
		this.spinner = new TitleSpinner((title) => {
			ctx.ui.setTitle?.(title);
		});
	}

	get context(): ExtrasContext {
		return this.ctx;
	}

	/** Start intercepting keys. The listener runs before the focused component
	 *  and can consume, which is the only way to build a chord on pi's API. */
	attach(): void {
		if (this.unsubscribe || typeof this.ctx.ui.onTerminalInput !== "function") return;
		try {
			this.unsubscribe = this.ctx.ui.onTerminalInput((data) => {
				const step = this.chord.feed(data, this.deps.now());
				this.showHint(step.pending ? step.stage : undefined);
				if (step.action) this.dispatch(step.action);
				return step.consume ? { consume: true } : undefined;
			});
		} catch {
			// No raw input in this mode. Commands still work.
		}
	}

	/** Draw or clear the half-typed-chord prompt. Cheap enough to call on every
	 *  keystroke: pi de-duplicates a widget set to the same content.
	 *
	 *  aboveEditor, and that is not a cosmetic choice. agent-statusline takes
	 *  pi's footer and draws every one of its rows inside a single belowEditor
	 *  widget, because its dashboard and activity rows share one line budget and
	 *  two components cannot see each other's line count. It then re-renders on
	 *  a 1Hz tick. A second belowEditor widget lands in that same container and
	 *  is blanked by the next tick -- observed as the prompt appearing and going
	 *  black about a second later. Above the editor is a different container,
	 *  nobody else's, and it puts the prompt next to what you are typing.
	 */
	private showHint(stage: "prefix" | "append" | undefined): void {
		if (typeof this.ctx.ui.setWidget !== "function") return;
		try {
			this.ctx.ui.setWidget(HINT_WIDGET_KEY, stage ? hintRows(stage) : undefined, {
				placement: "aboveEditor",
			});
		} catch {
			// A mode with no widgets. The chord still works, unprompted.
		}
	}

	detach(): void {
		this.showHint(undefined);
		this.chord.cancel();
		this.spinner.stop();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	/** Resolves once the action a chord started has finished. The terminal
	 *  listener cannot await it: it has to answer `consume` synchronously. */
	settled(): Promise<void> {
		return this.inflight;
	}

	startSpinner(): void {
		this.spinner.start(baseTitle(this.ctx.cwd, this.ctx.sessionManager?.getSessionName?.()));
	}

	stopSpinner(): void {
		this.spinner.stop();
	}

	private dispatch(action: ChordAction): void {
		this.inflight = this.inflight.then(() => this.run(action)).catch(() => {
			// One failed chord must not poison the queue behind it.
		});
	}

	private async run(action: ChordAction): Promise<void> {
		switch (action.kind) {
			case "stash":
				this.stashOrRestore();
				return;
			case "undo":
				this.step("undo");
				return;
			case "redo":
				this.step("redo");
				return;
			case "copy":
				await this.copy(this.text());
				return;
			case "cut":
				await this.cut();
				return;
			case "thinking":
				this.cycleThinking();
				return;
			case "append":
				this.append(action.register);
				return;
			case "tab":
				this.ctx.ui.pasteToEditor?.("\t");
				return;
		}
	}

	private text(): string {
		try {
			return this.ctx.ui.getEditorText?.() ?? "";
		} catch {
			return "";
		}
	}

	private setText(text: string): void {
		try {
			this.ctx.ui.setEditorText?.(text);
		} catch {
			// An editor that refuses a write is not a session-ending problem.
		}
	}

	private notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		try {
			this.ctx.ui.notify(`${NOTIFY_PREFIX}: ${message}`, type);
		} catch {
			// Nowhere to say it.
		}
	}

	private stashOrRestore(): void {
		const current = this.text();
		if (current.trim() !== "") {
			this.undo.record(current);
			this.stash.push(current);
			this.setText("");
			return;
		}
		const restored = this.stash.restore();
		if (restored === undefined) {
			this.notify("the stash is empty");
			return;
		}
		this.undo.record(current);
		this.setText(restored);
	}

	private step(direction: "undo" | "redo"): void {
		const current = this.text();
		const next = direction === "undo" ? this.undo.undo(current) : this.undo.redo(current);
		if (next === undefined) {
			this.notify(`nothing to ${direction}`);
			return;
		}
		this.setText(next);
	}

	private async copy(text: string): Promise<boolean> {
		if (text === "") return false;
		return copyToClipboard(text, this.deps.clipboard, this.deps.runClipboard);
	}

	/** The copy has to land before the text goes: a cut that silently dropped
	 *  the input on a host with no clipboard tool would be unrecoverable. */
	private async cut(): Promise<void> {
		const current = this.text();
		if (!(await this.copy(current))) return;
		this.undo.record(current);
		this.setText("");
	}

	private cycleThinking(): void {
		try {
			const level = nextThinkingLevel(this.pi.getThinkingLevel?.());
			this.pi.setThinkingLevel?.(level);
			this.notify(`thinking ${level}`);
		} catch {
			// A model with no reasoning support rejects the level. Nothing else changes.
		}
	}

	private append(register: RegisterName): void {
		const value = this.stash.register(register);
		if (value === undefined) {
			this.notify(`register ${register} is empty`);
			return;
		}
		const current = this.text();
		this.undo.record(current);
		this.setText(appended(current, value));
	}

	/** The stash overlay. Restore and cut share the undo buffer with the
	 *  chords, so a restore from here is undoable the same way. */
	async openOverlay(ctx: ExtrasContext): Promise<void> {
		if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
			this.notify(`stash: ${this.stash.list().length} saved`);
			return;
		}
		const theme = ctx.ui.theme ?? { fg: (_slot: string, text: string) => text };
		try {
			await ctx.ui.custom<void>(
				(tui, activeTheme, _keybindings, done) =>
					createStashComponent(
						tui,
						activeTheme ?? theme,
						{
							entries: () => this.stash.list(),
							persistent: () => this.stash.persistent,
							restore: (index) => {
								const entry = this.stash.restore(index);
								if (entry === undefined) return;
								this.undo.record(this.text());
								this.setText(entry);
							},
							copy: (index) => {
								const entry = this.stash.list()[index];
								if (entry !== undefined) this.dispatchCopy(entry);
							},
							remove: (index) => {
								this.stash.remove(index);
							},
							clearAll: () => {
								this.stash.clear();
							},
						},
						() => {
							done(undefined as void);
						},
					),
				{ overlay: true, overlayOptions: { width: "60%", minWidth: 40, maxHeight: "60%" } },
			);
		} catch {
			// An overlay that will not mount is not worth ending a session over.
		}
	}

	private dispatchCopy(text: string): void {
		this.inflight = this.inflight.then(async () => {
			await this.copy(text);
		});
	}
}

/** Widget slot for the half-typed-chord prompt. */
const HINT_WIDGET_KEY = "pi-extras:chord";

export function registerHandlers(pi: ExtrasHost, deps: ExtrasDeps): void {
	let session: ExtrasSession | undefined;

	const sessionFor = (ctx: ExtrasContext): ExtrasSession => {
		if (!session) {
			session = new ExtrasSession(pi, ctx, deps);
			session.attach();
		}
		return session;
	};

	pi.on("session_start", (_event: never, ctx: never) => {
		// A git command that opens an editor never returns, and the tool call
		// waiting on it never ends. Set this before anything can run one.
		try {
			deps.applyEnv(gitEditorOverrides(deps.env));
		} catch {
			// A frozen environment. Nothing else here depends on it.
		}
		session?.detach();
		session = undefined;
		sessionFor(ctx as unknown as ExtrasContext);
	});

	pi.on("agent_start", () => {
		session?.startSpinner();
	});

	pi.on("agent_settled", () => {
		session?.stopSpinner();
	});

	pi.on("session_shutdown", () => {
		session?.detach();
	});

	pi.on("input", (event: never) => {
		const text = (event as unknown as { text?: unknown }).text;
		if (typeof text !== "string") return { action: "continue" };
		const ctx = session?.context;
		const cwd = ctx?.cwd ?? deps.env.PWD ?? ".";

		const missing = unresolvedRefs(text, cwd, deps.homeDir, deps.exists);
		if (missing.length > 0) {
			try {
				ctx?.ui.notify(`${NOTIFY_PREFIX}: no such path ${missing.join(", ")}`, "warning");
			} catch {
				// Nowhere to say it. The message goes through unchanged either way.
			}
		}

		// pi resolves a relative @path against the cwd but leaves a tilde alone,
		// which hands the agent a directory literally named "~".
		const expanded = expandPathRefs(text, deps.homeDir);
		return expanded === text ? { action: "continue" } : { action: "transform", text: expanded };
	});

	const exit = {
		description: "Exit pi.",
		handler: async (_args: string, ctx: never) => {
			(ctx as unknown as ExtrasContext).shutdown?.();
		},
	};
	pi.registerCommand("exit", exit);
	pi.registerCommand("e", exit);

	pi.registerCommand("clear", {
		description: "Start a new session.",
		handler: async (_args: string, ctx: never) => {
			await (ctx as unknown as ExtrasContext).newSession?.();
		},
	});

	pi.registerCommand("clone-session", {
		description: "Clone this session into a new one, leaving the original untouched.",
		handler: async (_args: string, ctx: never) => {
			const c = ctx as unknown as ExtrasContext;
			const leaf = c.sessionManager?.getLeafId?.();
			if (!leaf) {
				c.ui.notify(`${NOTIFY_PREFIX}: nothing to clone yet`, "warning");
				return;
			}
			// Fork at the leaf rather than newSession({ parentSession }): a fork
			// copies the conversation, which is the point of cloning it into
			// another worktree.
			await c.fork?.(leaf, { position: "at" });
		},
	});

	pi.registerCommand("stash", {
		description: "Open the prompt stash: restore, copy, delete, or clear saved drafts.",
		handler: async (_args: string, ctx: never) => {
			const c = ctx as unknown as ExtrasContext;
			await sessionFor(c).openOverlay(c);
		},
	});
}

/** The real stash file. Both halves are allowed to throw: StashStore turns a
 *  failure here into a memory-only stash. */
function fileIO(path: string): StashIO {
	return {
		read: () => readFileSync(path, "utf8"),
		write: (data: string) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, data, { mode: 0o600 });
		},
	};
}

export default function (pi: ExtrasHost) {
	const env = process.env as Record<string, string | undefined>;
	registerHandlers(pi, {
		env,
		homeDir: homedir(),
		now: Date.now,
		exists: existsSync,
		clipboard: clipboardTargets(env),
		runClipboard: spawnRunner,
		applyEnv: (values) => {
			Object.assign(process.env, values);
		},
		stashIO: fileIO(stashPath(env, homedir())),
	});
}
