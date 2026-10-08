// The ask before a classifier block stands, as state: which answer is
// highlighted, how long is left, and the answer once there is one. Pure, so
// the keys and the countdown are testable without a terminal.

export type BlockAnswer = "allow" | "deny" | "timeout";

export const BLOCK_CHOICES = [
	{ answer: "allow", label: "Allow", key: "y" },
	{ answer: "deny", label: "Deny", key: "n" },
] as const satisfies readonly { answer: BlockAnswer; label: string; key: string }[];

export class BlockPrompt {
	cursor = 0;
	result: BlockAnswer | undefined;
	private readonly deadline: number;

	constructor(
		timeoutMs: number,
		private readonly now: () => number = Date.now,
	) {
		this.deadline = now() + timeoutMs;
	}

	/** Whole seconds left, never below zero. */
	secondsLeft(): number {
		return Math.max(0, Math.ceil((this.deadline - this.now()) / 1000));
	}

	move(delta: number): void {
		if (this.result) return;
		const n = BLOCK_CHOICES.length;
		this.cursor = (((this.cursor + delta) % n) + n) % n;
	}

	confirm(): void {
		this.result ??= BLOCK_CHOICES[this.cursor]!.answer;
	}

	/** A hotkey answers at once. */
	press(key: string): void {
		const choice = BLOCK_CHOICES.find((c) => c.key === key.toLowerCase());
		if (choice) this.result ??= choice.answer;
	}

	/** Esc refuses: the user is there and said no. */
	cancel(): void {
		this.result ??= "deny";
	}

	/** Called on each tick; out of time, the block stands. */
	tick(): void {
		if (!this.result && this.now() >= this.deadline) this.result = "timeout";
	}
}
