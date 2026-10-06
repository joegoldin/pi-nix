// The terminal tab title while the agent works.
//
// pi sets the title once per session (interactive-mode.ts updateTerminalTitle)
// and there is no way to read it back, so the base title is recomputed here
// from the same two inputs pi uses. Stopping repaints that base rather than
// leaving a frozen spinner glyph on a tab that is idle.

/** Braille dots: one cell wide in every terminal font, unlike most spinners. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export const SPINNER_INTERVAL_MS = 120;

export function baseTitle(cwd: string, sessionName?: string): string {
	if (sessionName) return sessionName;
	const name = cwd.replace(/\/+$/, "").split("/").pop();
	return name === undefined || name === "" ? "pi" : name;
}

export function spinnerTitle(base: string, tick: number): string {
	return `${SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} ${base}`;
}

export class TitleSpinner {
	private readonly setTitle: (title: string) => void;
	private readonly intervalMs: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private base = "";
	private frame = 0;

	constructor(setTitle: (title: string) => void, intervalMs = SPINNER_INTERVAL_MS) {
		this.setTitle = setTitle;
		this.intervalMs = intervalMs;
	}

	get running(): boolean {
		return this.timer !== undefined;
	}

	start(base: string): void {
		if (this.timer) return;
		this.base = base;
		this.frame = 0;
		this.paint(spinnerTitle(base, 0));
		this.timer = setInterval(() => {
			this.tick();
		}, this.intervalMs);
		// Never hold the process open for an animation.
		this.timer.unref?.();
	}

	tick(): void {
		if (!this.timer) return;
		this.frame++;
		this.paint(spinnerTitle(this.base, this.frame));
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
		this.paint(this.base);
	}

	private paint(title: string): void {
		try {
			this.setTitle(title);
		} catch {
			// A mode without a terminal. The spinner is cosmetic; the session is not.
		}
	}
}
