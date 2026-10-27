export type Tone = "neutral" | "success" | "warning" | "error";
export type ModelChoice = "qwen" | "luna";
export interface Beat {
	text: string;
	tone: Tone;
	from: string;
	to: string;
	recap?: boolean;
	omitted?: number;
}
export interface Usage {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	unknownCost: number;
	unknownTokens: number;
}
export interface Snapshot {
	version: 1;
	enabled: boolean;
	model: ModelChoice;
	lastId: string;
	earlier?: Beat;
	chapters: Beat[];
	recent: Beat[];
	now: string;
	usage: Usage;
}
export interface Batch {
	from: string;
	to: string;
	omitted: number;
	events: Array<{ id: string; text: string }>;
}
export const STATE_TYPE = "pi-minimap:state";
export const emptyUsage = (): Usage => ({
	requests: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	unknownCost: 0,
	unknownTokens: 0,
});
export const emptySnapshot = (): Snapshot => ({
	version: 1,
	enabled: false,
	model: "qwen",
	lastId: "",
	chapters: [],
	recent: [],
	now: "",
	usage: emptyUsage(),
});
export function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
export function clean(value: string, limit: number): string {
	return value
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);
}
function excerpt(value: string): string {
	const redacted = value
		.replace(
			/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
			"[redacted private key]",
		)
		.replace(
			/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|xox[baprs]-[\w-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
			"[redacted credential]",
		)
		.replace(/\b(Bearer\s+)[\w.\-]+/gi, "$1[redacted]")
		.replace(
			/\b(api[_-]?key|password|secret|(?:access[_-]?)?token)["']?\s*[:=]\s*["']?[^\s"']+/gi,
			"$1=[redacted]",
		);
	return clean(redacted, 480);
}
function messageText(message: Record<string, unknown>): string {
	const role = String(message.role);
	if (role === "toolResult")
		return `Tool ${clean(String(message.toolName ?? "result"), 60)} ${message.isError === true ? "failed" : "completed"}. Output omitted.`;
	if (typeof message.content === "string")
		return `${role}: ${excerpt(message.content)}`;
	if (!Array.isArray(message.content)) return role;
	const pieces: string[] = [];
	for (const block of message.content) {
		if (!record(block)) continue;
		if (block.type === "text" && typeof block.text === "string")
			pieces.push(excerpt(block.text));
		else if (block.type === "toolCall" && typeof block.name === "string") {
			const args = record(block.arguments) ? block.arguments : {};
			const target = [args.path, args.file_path, args.subject, args.name].find(
				(value) => typeof value === "string",
			);
			pieces.push(
				`Tool call: ${clean(block.name, 60)}${typeof target === "string" ? ` · ${excerpt(target).slice(0, 160)}` : ""} (argument bodies omitted)`,
			);
		}
		if (pieces.join(" ").length >= 480) break;
	}
	return `${role}: ${pieces.join(" ").slice(0, 480)}`;
}

/** Select before extracting text: no thinking, images, raw tool arguments or output. */
export function readBatch(
	branch: unknown[],
	lastId: string,
): Batch | undefined {
	const messages = branch.filter(
		(
			entry,
		): entry is Record<string, unknown> & {
			id: string;
			message: Record<string, unknown>;
		} =>
			record(entry) &&
			entry.type === "message" &&
			typeof entry.id === "string" &&
			record(entry.message) &&
			["user", "assistant", "toolResult"].includes(String(entry.message.role)),
	);
	const at = lastId ? messages.findIndex((entry) => entry.id === lastId) : -1;
	const fresh = messages.slice(at + 1);
	if (!fresh.length) return;
	const selected =
		fresh.length <= 12 ? fresh : [...fresh.slice(0, 2), ...fresh.slice(-10)];
	return {
		from: fresh[0]!.id,
		to: fresh.at(-1)!.id,
		omitted: fresh.length - selected.length,
		events: selected.map((entry) => ({
			id: entry.id,
			text: messageText(entry.message),
		})),
	};
}

const tones: Tone[] = ["neutral", "success", "warning", "error"];
function beat(value: unknown, ids: Set<string>, limit: number): value is Beat {
	return (
		record(value) &&
		typeof value.text === "string" &&
		value.text.length <= limit &&
		tones.includes(value.tone as Tone) &&
		typeof value.from === "string" &&
		ids.has(value.from) &&
		typeof value.to === "string" &&
		ids.has(value.to) &&
		(value.recap === undefined || typeof value.recap === "boolean") &&
		(value.omitted === undefined ||
			(Number.isSafeInteger(value.omitted) && Number(value.omitted) >= 0))
	);
}
function decodeUsage(value: unknown): Usage | undefined {
	if (!record(value)) return;
	const usage = emptyUsage();
	for (const key of Object.keys(usage) as Array<keyof Usage>) {
		const amount = value[key];
		if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)
			return;
		if (key !== "cost" && !Number.isSafeInteger(amount)) return;
		usage[key] = amount;
	}
	if (
		usage.unknownCost > usage.requests ||
		usage.unknownTokens > usage.requests
	)
		return;
	return usage;
}
export function restoreUsage(entries: unknown[], sessionId: string): Usage {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			!record(entry) ||
			entry.type !== "custom" ||
			entry.customType !== STATE_TYPE ||
			!record(entry.data) ||
			entry.data.version !== 1 ||
			entry.data.usageSessionId !== sessionId
		)
			continue;
		const usage = decodeUsage(entry.data.usage);
		if (usage) return usage;
	}
	return emptyUsage();
}

export function restore(branch: unknown[]): Snapshot {
	const ids = new Set(
		branch
			.filter(record)
			.map((entry) => entry.id)
			.filter((id): id is string => typeof id === "string"),
	);
	for (const entry of [...branch].reverse()) {
		if (
			!record(entry) ||
			entry.type !== "custom" ||
			entry.customType !== STATE_TYPE ||
			!record(entry.data)
		)
			continue;
		const value = entry.data;
		if (
			value.version !== 1 ||
			typeof value.enabled !== "boolean" ||
			!["qwen", "luna"].includes(String(value.model)) ||
			typeof value.lastId !== "string" ||
			(value.lastId !== "" && !ids.has(value.lastId)) ||
			typeof value.now !== "string" ||
			value.now.length > 180 ||
			!record(value.usage)
		)
			continue;
		const usage = decodeUsage(value.usage);
		if (!usage) continue;
		if (value.earlier !== undefined && !beat(value.earlier, ids, 500)) continue;
		if (
			!Array.isArray(value.chapters) ||
			value.chapters.length > 2 ||
			!value.chapters.every((item) => beat(item, ids, 180))
		)
			continue;
		if (
			!Array.isArray(value.recent) ||
			value.recent.length > 6 ||
			!value.recent.every((item) => beat(item, ids, 180))
		)
			continue;
		const copy = (item: Beat): Beat => ({
			text: clean(item.text, 500),
			tone: item.tone,
			from: item.from,
			to: item.to,
			recap: item.recap,
			omitted: item.omitted,
		});
		return {
			version: 1,
			enabled: value.enabled,
			model: value.model as ModelChoice,
			lastId: value.lastId,
			now: clean(value.now, 180),
			earlier: value.earlier ? copy(value.earlier as Beat) : undefined,
			chapters: value.chapters.map((item) => copy(item as Beat)),
			recent: value.recent.map((item) => copy(item as Beat)),
			usage,
		};
	}
	return emptySnapshot();
}

export interface Summary {
	beat: string;
	tone: Tone;
	now: string;
	chapter: string;
	earlier: string;
}
export function parseSummary(
	text: string,
	fold: boolean,
	compact: boolean,
): Summary {
	let value: unknown;
	try {
		value = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
	} catch {
		throw new Error("Invalid minimap JSON");
	} // Do not expose provider text in parser errors.
	if (
		!record(value) ||
		typeof value.beat !== "string" ||
		typeof value.now !== "string" ||
		!value.now.trim() ||
		!tones.includes(value.tone as Tone) ||
		(fold &&
			value.beat.trim() &&
			(typeof value.chapter !== "string" || !value.chapter.trim())) ||
		(compact &&
			value.beat.trim() &&
			(typeof value.earlier !== "string" || !value.earlier.trim()))
	)
		throw new Error("Invalid minimap summary");
	return {
		beat: clean(value.beat, 180),
		tone: value.tone as Tone,
		now: clean(value.now, 180),
		chapter: typeof value.chapter === "string" ? clean(value.chapter, 180) : "",
		earlier: typeof value.earlier === "string" ? clean(value.earlier, 500) : "",
	};
}

export function applySummary(
	state: Snapshot,
	batch: Batch,
	summary: Summary,
	recap: boolean,
): void {
	if (!summary.beat) {
		state.now = summary.now;
		state.lastId = batch.to;
		return;
	}
	if (state.recent.length >= 6) {
		if (state.chapters.length >= 2) {
			state.earlier = {
				text: summary.earlier,
				tone: "neutral",
				from: state.earlier?.from ?? state.chapters[0]!.from,
				to: state.chapters.at(-1)!.to,
			};
			state.chapters = [];
		}
		const folded = state.recent.splice(0, 3);
		state.chapters.push({
			text: summary.chapter,
			tone: "neutral",
			from: folded[0]!.from,
			to: folded.at(-1)!.to,
		});
	}
	state.recent.push({
		text: summary.beat,
		tone: summary.tone,
		from: batch.from,
		to: batch.to,
		recap,
		omitted: batch.omitted || undefined,
	});
	state.now = summary.now;
	state.lastId = batch.to;
}
