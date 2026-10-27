export type Tone = "neutral" | "success" | "warning" | "error";
export type ModelChoice = "qwen" | "luna";
export const eventKinds = [
	"ask",
	"decision",
	"change",
	"check",
	"blocker",
	"note",
] as const;
export type EventKind = (typeof eventKinds)[number];
const timestamp = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
export interface Beat {
	bullets?: string[];
	at?: number;
	kind?: EventKind;
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
export interface FocusTopic {
	topic: string;
	subtopics: string[];
}
export interface Snapshot {
	focus?: FocusTopic[];
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
	at?: number;
	from: string;
	to: string;
	omitted: number;
	events: Array<{ id: string; text: string }>;
}
export const CALL_TYPE = "pi-minimap:call";
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
	enabled: true,
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
export function redact(value: string): string {
	return value
		.replace(
			/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
			"[redacted private key]",
		)
		.replace(
			/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|xox[baprs]-[\w-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
			"[redacted credential]",
		)
		.replace(/\b(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
		.replace(
			/\b((?:[\w]+[_-])?(?:api[_-]?key|private[_-]?key|password|secret|(?:access[_-]?)?token))["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)/gi,
			"$1=[redacted]",
		);
}
function excerpt(value: string, limit = 480, keepEnds = false): string {
	const redacted = redact(value);
	const text = clean(
		redacted.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
		keepEnds ? redacted.length : limit,
	);
	if (!keepEnds || text.length <= limit) return text;
	const head = Math.floor(limit / 4);
	return `${text.slice(0, head)} … ${text.slice(-(limit - head - 3))}`;
}
function messageText(message: Record<string, unknown>, limit: number): string {
	const role = String(message.role);
	if (role === "toolResult") {
		let output =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.filter(record)
							.filter(
								(block) =>
									block.type === "text" && typeof block.text === "string",
							)
							.map((block) => block.text)
							.join("\n")
					: "";
		let exit = "";
		try {
			const value: unknown =
				output.length <= 128_000 ? JSON.parse(output) : undefined;
			if (record(value)) {
				const code = value.exit_code ?? value.exitCode;
				if (typeof code === "number" && Number.isSafeInteger(code))
					exit = ` Exit code ${code}.`;
				if (typeof value.output === "string") output = value.output;
			}
		} catch {
			/* Most tool output is plain text. */
		}
		const blocked = /tool did not run|authorizer denied|action blocked/i.test(
			output,
		);
		const outcome = blocked
			? "did not run (permission gate blocked execution)"
			: message.isError === true
				? "failed"
				: "completed";
		return `Tool ${clean(String(message.toolName ?? "result"), 60)} ${outcome}.${exit} Output excerpt: ${excerpt(output, limit, true)}`;
	}
	if (typeof message.content === "string")
		return `${role}: ${excerpt(message.content, limit)}`;
	if (!Array.isArray(message.content)) return role;
	const pieces: string[] = [];
	for (const block of message.content) {
		if (!record(block)) continue;
		if (block.type === "text" && typeof block.text === "string")
			pieces.push(excerpt(block.text, limit));
		else if (block.type === "toolCall" && typeof block.name === "string") {
			const args = record(block.arguments) ? block.arguments : {};
			const target = [args.path, args.file_path, args.subject, args.name].find(
				(value) => typeof value === "string",
			);
			pieces.push(
				`Tool call: ${clean(block.name, 60)}${typeof target === "string" ? ` · ${excerpt(target).slice(0, 160)}` : ""} (argument bodies omitted)`,
			);
		}
		if (pieces.join(" ").length >= limit) break;
	}
	return `${role}: ${pieces.join(" ").slice(0, limit)}`;
}

/** Select before extracting text: no thinking, images or argument bodies; output excerpts stay bounded. */
export function readBatch(
	branch: unknown[],
	lastId: string,
	recap = true,
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
	const count = recap ? 12 : 8;
	const selected =
		fresh.length <= count
			? fresh
			: [...fresh.slice(0, 2), ...fresh.slice(-(count - 2))];
	return {
		at: timestamp(fresh.at(-1)!.message.timestamp),
		from: fresh[0]!.id,
		to: fresh.at(-1)!.id,
		omitted: fresh.length - selected.length,
		events: selected.map((entry) => ({
			id: entry.id,
			text: messageText(entry.message, recap ? 480 : 240),
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
			![STATE_TYPE, CALL_TYPE].includes(String(entry.customType)) ||
			!record(entry.data) ||
			entry.data.version !== 1 ||
			(entry.customType === STATE_TYPE
				? entry.data.usageSessionId !== sessionId
				: entry.data.phase !== "accounting" ||
					entry.data.sessionId !== sessionId)
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
			bullets: item.bullets ? earlierBullets(item.bullets) : undefined,
			at: timestamp(item.at),
			kind: eventKinds.includes(item.kind as EventKind) ? item.kind : undefined,
		});
		return {
			version: 1,
			enabled: value.enabled,
			model: value.model as ModelChoice,
			lastId: value.lastId,
			now: clean(value.now, 180),
			focus: parseFocus(value.focus),
			earlier: value.earlier ? copy(value.earlier as Beat) : undefined,
			chapters: value.chapters.map((item) => copy(item as Beat)),
			recent: value.recent.map((item) => copy(item as Beat)),
			usage,
		};
	}
	return emptySnapshot();
}

export function parseFocus(value: unknown): FocusTopic[] | undefined {
	if (!Array.isArray(value)) return;
	const topics = value
		.filter(record)
		.filter((item) => typeof item.topic === "string" && item.topic.trim())
		.slice(0, 2)
		.map((item) => ({
			topic: clean(String(item.topic), 64),
			subtopics: Array.isArray(item.subtopics)
				? item.subtopics
						.filter(
							(text): text is string =>
								typeof text === "string" && !!text.trim(),
						)
						.slice(0, 3)
						.map((text) => clean(text, 64))
				: [],
		}));
	if (!topics.length) return;
	let remaining = 4 - topics.length;
	return topics.map((topic, index) => {
		const reserve = topics
			.slice(index + 1)
			.filter((next) => next.subtopics.length).length;
		const subtopics = topic.subtopics.slice(
			0,
			Math.max(0, remaining - reserve),
		);
		remaining -= subtopics.length;
		return { ...topic, subtopics };
	});
}
const indices = (value: unknown): value is number[] =>
	Array.isArray(value) &&
	value.length <= 6 &&
	value.every((index) => Number.isInteger(index) && index >= 0 && index < 6) &&
	new Set(value).size === value.length;

export function earlierBullets(value: unknown): string[] {
	const parts =
		typeof value === "string"
			? value.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/u)
			: Array.isArray(value)
				? value
				: [];
	return parts
		.filter((text): text is string => typeof text === "string" && !!text.trim())
		.slice(0, 3)
		.map((text) => {
			const line = clean(text.replace(/^\s*[-•*]\s*/, ""), 101);
			return line.length > 100 ? `${line.slice(0, 99)}…` : line;
		});
}
export interface Summary {
	earlierBullets?: string[];
	focus?: FocusTopic[];
	dropRecent?: number[];
	kind?: EventKind;
	replaceRecent?: number;
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
	const focus = record(value) ? parseFocus(value.focus) : undefined;
	if (
		!record(value) ||
		typeof value.beat !== "string" ||
		((typeof value.now !== "string" || !value.now.trim()) && !focus) ||
		!tones.includes(value.tone as Tone) ||
		(value.dropRecent != null && !indices(value.dropRecent)) ||
		(value.replaceRecent !== undefined &&
			value.replaceRecent !== null &&
			(!Number.isInteger(value.replaceRecent) ||
				Number(value.replaceRecent) < 0 ||
				Number(value.replaceRecent) > 5)) ||
		(fold &&
			value.replaceRecent == null &&
			!(Array.isArray(value.dropRecent) && value.dropRecent.length) &&
			value.beat.trim() &&
			(typeof value.chapter !== "string" || !value.chapter.trim())) ||
		(compact &&
			value.replaceRecent == null &&
			!(Array.isArray(value.dropRecent) && value.dropRecent.length) &&
			value.beat.trim() &&
			!earlierBullets(value.earlier).length)
	)
		throw new Error("Invalid minimap summary");
	return {
		dropRecent: indices(value.dropRecent) ? value.dropRecent : [],
		replaceRecent:
			typeof value.replaceRecent === "number" ? value.replaceRecent : undefined,
		kind: eventKinds.includes(value.kind as EventKind)
			? (value.kind as EventKind)
			: undefined,
		beat: clean(value.beat, 180),
		tone: value.tone as Tone,
		now:
			typeof value.now === "string" && value.now.trim()
				? clean(value.now, 180)
				: focus!.map((topic) => topic.topic).join("; "),
		focus,
		chapter: typeof value.chapter === "string" ? clean(value.chapter, 180) : "",
		earlier: earlierBullets(value.earlier).join(" "),
		earlierBullets: earlierBullets(value.earlier),
	};
}

export function applySummary(
	state: Snapshot,
	batch: Batch,
	summary: Summary,
	recap: boolean,
	rewriteEarlier = false,
): void {
	const drops = new Set(summary.dropRecent ?? []);
	if (
		[...drops].some((index) => !state.recent[index]) ||
		(summary.replaceRecent !== undefined &&
			(!state.recent[summary.replaceRecent] ||
				drops.has(summary.replaceRecent)))
	)
		throw new Error("Invalid minimap revision");
	const normalized = (text: string) =>
		text
			.toLowerCase()
			.replace(/[.!?]+$/g, "")
			.trim();
	const duplicate = state.recent.findIndex(
		(item, index) =>
			!drops.has(index) && normalized(item.text) === normalized(summary.beat),
	);
	const replace =
		summary.replaceRecent ?? (duplicate >= 0 ? duplicate : undefined);
	const previous = replace === undefined ? undefined : state.recent[replace];
	state.recent = state.recent.flatMap((item, index) => {
		if (drops.has(index)) return [];
		if (index !== replace || !summary.beat) return [item];
		return [
			{
				...item,
				text: summary.beat,
				tone: summary.tone,
				to: batch.to,
				kind: summary.kind ?? item.kind,
				at: duplicate === replace ? item.at : batch.at,
				recap: item.recap || recap,
				omitted: (item.omitted ?? 0) + batch.omitted || undefined,
			},
		];
	});
	state.now = summary.now;
	state.focus = summary.focus;
	if (rewriteEarlier && state.earlier && summary.earlierBullets?.length)
		state.earlier = {
			...state.earlier,
			text: summary.earlier,
			bullets: summary.earlierBullets,
		};
	state.lastId = batch.to;
	if (!summary.beat || previous) return;
	if (state.recent.length >= 6) {
		if (state.chapters.length >= 2) {
			state.earlier = {
				text: summary.earlier,
				bullets: summary.earlierBullets,
				at: state.chapters.at(-1)!.at,
				tone: "neutral",
				from: state.earlier?.from ?? state.chapters[0]!.from,
				to: state.chapters.at(-1)!.to,
			};
			state.chapters = [];
		}
		const folded = state.recent.splice(0, 3);
		state.chapters.push({
			text: summary.chapter,
			at: folded.at(-1)!.at,
			tone: "neutral",
			from: folded[0]!.from,
			to: folded.at(-1)!.to,
		});
	}
	state.recent.push({
		text: summary.beat,
		at: batch.at,
		kind: summary.kind,
		tone: summary.tone,
		from: batch.from,
		to: batch.to,
		recap,
		omitted: batch.omitted || undefined,
	});
	state.now = summary.now;
	state.lastId = batch.to;
}
