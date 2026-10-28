// The ask before a classifier block stands, as state: which answer is
// highlighted, how long is left, and the answer once there is one. Pure, so
// the keys and the countdown are testable without a terminal.

export type BlockAnswer = "allow-session" | "allow" | "deny" | "timeout";

export const BLOCK_CHOICES = [
	{ answer: "allow-session", label: "Allow this scope for this session", key: "y" },
	{ answer: "allow", label: "Allow once", key: "Y" },
	{ answer: "deny", label: "Deny", key: "n" },
] as const satisfies readonly { answer: BlockAnswer; label: string; key: string }[];

export class BlockPrompt {
	cursor = 0;
	result: BlockAnswer | undefined;
	private readonly deadline: number;
	private pausedAt: number | undefined;

	get explaining(): boolean {
		return this.pausedAt !== undefined;
	}

	constructor(
		timeoutMs: number,
		private readonly now: () => number = Date.now,
		private readonly canRemember = false,
		private readonly scopeOnly = false,
	) {
		this.deadline = now() + timeoutMs;
	}

	get choices() {
		return BLOCK_CHOICES.filter((choice) => (this.canRemember || choice.answer !== "allow-session") && (!this.scopeOnly || choice.answer !== "allow"));
	}

	/** Whole seconds left, never below zero. */
	secondsLeft(): number {
		return Math.max(0, Math.ceil((this.deadline - (this.pausedAt ?? this.now())) / 1000));
	}

	move(delta: number): void {
		if (this.result) return;
		const n = this.choices.length;
		this.cursor = (((this.cursor + delta) % n) + n) % n;
	}

	confirm(): void {
		this.result ??= this.choices[this.cursor]!.answer;
	}

	/** A hotkey answers at once. */
	press(key: string): void {
		if (key === "e" && !this.result) {
			this.pausedAt ??= this.now();
			return;
		}
		const choice = this.choices.find((c) => c.key === key);
		if (choice) this.result ??= choice.answer;
	}

	/** Esc refuses: the user is there and said no. */
	cancel(): void {
		this.result ??= "deny";
	}

	/** Called on each tick; out of time, the block stands. */
	tick(): void {
		if (!this.result && !this.explaining && this.now() >= this.deadline) this.result = "timeout";
	}
}
