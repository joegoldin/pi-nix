// The <cross-session-message> envelope Claude Code wraps every peer message
// in. Pure.
//
// Claude parses an envelope strictly: attributes in one fixed order, each
// matching its own pattern, and the whole string must equal what Claude would
// rebuild from the parsed parts. An envelope that fails is still delivered but
// shown unattributed, so this builds only what survives that check: a
// sanitised name, a percent-encoded address, and a body in which anything
// that could pass for the tag's opener or closer has its bracket escaped to
// "<\". Claude itself only needs closers escaped; escaping openers too keeps a
// body from ever reading as a nested message, and is harmless because Claude
// leaves an escaped bracket alone.

export const TAG = "cross-session-message";

export type FromMode = "bypass" | "prompting";
export const FROM_MODES: readonly FromMode[] = ["bypass", "prompting"];

export interface EnvelopeAttrs {
	from?: string;
	fromSession?: string;
	hopChain?: string[];
	fromName?: string;
	fromMode?: FromMode;
	fromPlugin?: string;
}

export interface Envelope extends EnvelopeAttrs {
	body: string;
}

const MAX_NAME_CHARS = 64;
const ADDRESS = /^[A-Za-z0-9%:_/.\\-]{1,300}$/;
const SESSION = /^[A-Za-z0-9_-]{1,80}$/;
const HOP_CHAIN = /^[0-9a-f]{24}(?:,[0-9a-f]{24}){0,31}$/;

// Characters people (and models) use for "<", ">" and "/" when they want to
// slip a tag past a filter that only looks for the ASCII ones.
const OPEN_LOOKALIKES = "＜﹤〈⟨〈‹˂ᐸ❬❮❰⧼≮≺⋖";
const CLOSE_LOOKALIKES = "＞﹥〉⟩〉›˃ᐳ❭❯❱⧽≯≻⋗";
// Anything between the bracket and the name that a renderer could ignore:
// spaces, slashes and their look-alikes, invisible and format characters.
const FILLER = `[^A-Za-z0-9_\\-<>${OPEN_LOOKALIKES}${CLOSE_LOOKALIKES}]`;
// Zero-width and combining characters that can hide inside the name.
const HIDDEN = "[\\p{Cc}\\p{Cf}\\p{Mn}\\p{Me}\\u2028\\u2029\\u115F\\u1160\\u3164\\uFFA0]*";
const SEPARATOR = "[\\-_\\p{Pd}\\p{Pc}\\u2212\\u207B\\u208B\\u02D7\\u2796\\u2043\\u30FC\\uFF70\\u2017\\u02CD\\u07FA\\u0640]";
// Cyrillic, Greek and small-capital letters that render like the Latin ones
// in the tag; case-insensitive Unicode matching covers forms like the long s.
const LETTER: Record<string, string> = {
	a: "aаαᴀ",
	c: "cсϲᴄ",
	e: "eеεᴇ",
	g: "gɢ",
	i: "iіιɪ",
	m: "mмᴍ",
	n: "nɴ",
	o: "oоοᴏ",
	r: "rгᴦʀ",
	s: "sѕꜱ",
};

const TAG_LOOKALIKE = new RegExp(
	`[<${OPEN_LOOKALIKES}](?!\\\\)(?=${FILLER}*${[...TAG]
		.map((ch) => (ch === "-" ? SEPARATOR : `[${LETTER[ch] ?? ch}]`))
		.join(HIDDEN)}(?:[^A-Za-z0-9_-]|$))`,
	"giu",
);

/** Escapes every opener or closer of the tag, or anything that could pass for one. */
export function escapeBody(body: string): string {
	return body.replace(TAG_LOOKALIKE, "<\\");
}

/** A display name Claude keeps byte for byte: no quotes, brackets or control characters, at most 64 characters. */
export function sanitizeName(name: string): string {
	const cleaned = name
		.replace(/["<>]/g, "")
		.replace(/\s+/g, " ")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	return [...cleaned].slice(0, MAX_NAME_CHARS).join("").trim();
}

function attributes(attrs: EnvelopeAttrs): string {
	const out: string[] = [];
	if (attrs.from && ADDRESS.test(attrs.from)) out.push(`from="${attrs.from}"`);
	if (attrs.fromSession && SESSION.test(attrs.fromSession)) out.push(`from-session="${attrs.fromSession}"`);
	const chain = attrs.hopChain?.join(",");
	if (chain && HOP_CHAIN.test(chain)) out.push(`hop-chain="${chain}"`);
	const name = attrs.fromName === undefined ? "" : sanitizeName(attrs.fromName);
	if (name) out.push(`from-name="${name}"`);
	if (attrs.fromMode && FROM_MODES.includes(attrs.fromMode)) out.push(`from-mode="${attrs.fromMode}"`);
	const plugin = attrs.fromPlugin === undefined ? "" : sanitizeName(attrs.fromPlugin);
	if (plugin) out.push(`from-plugin="${plugin}"`);
	return out.length ? ` ${out.join(" ")}` : "";
}

export function buildEnvelope(attrs: EnvelopeAttrs, body: string): string {
	return `<${TAG}${attributes(attrs)}>\n${escapeBody(body)}\n</${TAG}>`;
}

const ENVELOPE = new RegExp(
	`^<${TAG}` +
		'(?: from="([A-Za-z0-9%:_/.\\\\-]{1,300})")?' +
		'(?: from-session="([A-Za-z0-9_-]{1,80})")?' +
		'(?: hop-chain="([0-9a-f]{24}(?:,[0-9a-f]{24}){0,31})")?' +
		'(?: from-name="([^"<>\\n\\r]+)")?' +
		`(?: from-mode="(${FROM_MODES.join("|")})")?` +
		'(?: from-plugin="([^"<>\\n\\r]+)")?' +
		`>\\n([\\s\\S]*)\\n</${TAG}>$`,
);

/** The parts of an envelope, or undefined when the text is not one. */
export function parseEnvelope(text: string): Envelope | undefined {
	const m = ENVELOPE.exec(text);
	if (!m) return undefined;
	const [, from, fromSession, hopChain, fromName, fromMode, fromPlugin, body = ""] = m;
	return {
		...(from !== undefined && { from }),
		...(fromSession !== undefined && { fromSession }),
		...(hopChain !== undefined && { hopChain: hopChain.split(",") }),
		...(fromName !== undefined && { fromName }),
		...(fromMode !== undefined && { fromMode: fromMode as FromMode }),
		...(fromPlugin !== undefined && { fromPlugin }),
		body,
	};
}
