// The line written after a run: "✓ 57s · done 11:11 AM · 1 shell still
// running". Pure, so the wording and the time format are testable.
//
// Modelled on the summary Claude Code prints when a turn ends, without its
// rotating verbs: how long, when it finished, and what is still going in the
// background, which is the part that answers "is it actually done?".

export interface RunSummary {
	elapsedMs: number;
	/** When the run ended, as epoch milliseconds. */
	doneAt: number;
	/** bg_run shells still running. */
	shells: number;
	/** True when the run ended on a model or provider error. */
	failed: boolean;
}

/** 6s, 1m 12s, 1h 3m: the two largest units, the second dropped when zero. */
export function duration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
	if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
	return `${s}s`;
}

/** The clock time in the user's own locale and time zone, hours and minutes. */
export function clock(at: number, locale?: string, timeZone?: string): string {
	return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(at);
}

export function summaryText(s: RunSummary, locale?: string, timeZone?: string): string {
	const parts = [`${s.failed ? "✗" : "✓"} ${duration(s.elapsedMs)}`, `done ${clock(s.doneAt, locale, timeZone)}`];
	if (s.shells > 0) parts.push(`${s.shells} ${s.shells === 1 ? "shell" : "shells"} still running`);
	return parts.join(" · ");
}
