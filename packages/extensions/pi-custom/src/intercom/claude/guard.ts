// Bounds on what peers can make us do, and the memory of what we sent. Pure,
// with the clock passed in, so the timing is testable.
//
// Any process running as this user can connect to our socket, and every
// message it sends may start a turn. The limits match the ones Claude applies
// to its own inbound peers: a bucket of 30 per sender refilled at one every two
// seconds, and a repeated msg_id within 30 s is dropped.

export const BUCKET_SIZE = 30;
export const REFILL_PER_SECOND = 0.5;
export const DUPLICATE_WINDOW_MS = 30_000;
/** How long a sent message's id stays matchable to a receipt. Held messages wait on a human. */
export const SENT_TTL_MS = 60 * 60_000;

type Clock = () => number;

/** A token bucket per sender. */
export class RateLimiter {
	private buckets = new Map<string, { tokens: number; at: number }>();

	constructor(
		private readonly now: Clock = Date.now,
		private readonly size = BUCKET_SIZE,
		private readonly perSecond = REFILL_PER_SECOND,
	) {}

	/** Takes one token for this sender; false when it has none left. */
	take(sender: string): boolean {
		const now = this.now();
		const b = this.buckets.get(sender) ?? { tokens: this.size, at: now };
		b.tokens = Math.min(this.size, b.tokens + ((now - b.at) / 1000) * this.perSecond);
		b.at = now;
		this.buckets.set(sender, b);
		this.prune(now);
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}

	// A full bucket is the same as no bucket, so senders that have gone quiet
	// long enough are forgotten.
	private prune(now: number): void {
		if (this.buckets.size < 256) return;
		const full = (this.size / this.perSecond) * 1000;
		for (const [k, b] of this.buckets) if (now - b.at >= full) this.buckets.delete(k);
	}
}

/** Remembers ids for a while; seen() is true for a repeat inside the window. */
export class DuplicateWindow {
	private ids = new Map<string, number>();

	constructor(
		private readonly now: Clock = Date.now,
		private readonly windowMs = DUPLICATE_WINDOW_MS,
	) {}

	seen(id: string): boolean {
		const now = this.now();
		for (const [k, at] of this.ids) {
			if (now - at < this.windowMs) break;
			this.ids.delete(k);
		}
		if (this.ids.has(id)) return true;
		this.ids.set(id, now);
		return false;
	}
}

/** A map whose entries expire, oldest first. */
export class TtlMap<V> {
	private entries = new Map<string, { value: V; at: number }>();

	constructor(
		private readonly now: Clock = Date.now,
		private readonly ttlMs = SENT_TTL_MS,
	) {}

	set(key: string, value: V): void {
		this.entries.delete(key);
		this.entries.set(key, { value, at: this.now() });
		this.expire();
	}

	get(key: string): V | undefined {
		this.expire();
		return this.entries.get(key)?.value;
	}

	delete(key: string): void {
		this.entries.delete(key);
	}

	values(): V[] {
		this.expire();
		return [...this.entries.values()].map((e) => e.value);
	}

	private expire(): void {
		const now = this.now();
		for (const [k, e] of this.entries) {
			if (now - e.at < this.ttlMs) break;
			this.entries.delete(k);
		}
	}
}
