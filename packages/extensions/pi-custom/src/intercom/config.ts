// intercom's settings: $PI_CODING_AGENT_DIR/intercom/config.json, the file
// pi-nix's `messaging` option writes.
//
// The file is the switch. With no file intercom stays off, so loading
// pi-custom never starts a broker or joins Claude Code's peer list on its own;
// the messaging option is what turns it on. pi-intercom treated a missing file
// as on, which suited a package you install to get messaging and does not suit
// one that carries the whole setup.
//
// A malformed file turns intercom off with a reason instead of throwing.
// pi-intercom's README promised that but its loader threw from the extension
// factory, which took every other pi-intercom feature down with it; here it
// would take the rest of pi-custom down too.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type InboundTrigger = "always" | "replies" | "never";
export type BusyDelivery = "steer" | "human-first";
export type FromMode = "prompting" | "bypass";

export interface IntercomConfig {
	enabled: boolean;
	/** Why intercom is off when the file asked for it on but could not be read. */
	disabledReason?: string;
	/** The interpreter the broker runs under; absent means this process's own. */
	brokerCommand?: string;
	brokerArgs: string[];
	confirmSend: boolean;
	inboundTrigger: InboundTrigger;
	busyDelivery: BusyDelivery;
	replyHint: boolean;
	/** Suffix after the automatic status peers see, e.g. "reviewing". */
	status?: string;
	stableId?: string;
	claude: {
		/** Join Claude Code's peer list so Claude sessions can list and message this one. */
		enabled: boolean;
		/**
		 * The permission mode asserted to Claude. Claude holds a message for
		 * approval when this differs from its own mode, so a bypass-mode Claude
		 * session holds messages from a "prompting" pi.
		 */
		fromMode: FromMode;
	};
}

export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;

const OFF: IntercomConfig = {
	enabled: false,
	brokerArgs: [],
	confirmSend: false,
	inboundTrigger: "replies",
	busyDelivery: "steer",
	replyHint: true,
	claude: { enabled: true, fromMode: "prompting" },
};

export function intercomDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "intercom");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(intercomDir(env), "config.json");
}

/** Read the config file; never throws. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): IntercomConfig {
	let raw: string;
	try {
		raw = readFileSync(configPath(env), "utf8");
	} catch {
		return { ...OFF, claude: { ...OFF.claude } };
	}
	try {
		return parseConfig(JSON.parse(raw));
	} catch (error) {
		return {
			...OFF,
			claude: { ...OFF.claude },
			disabledReason: `${configPath(env)}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new Error(`"${key}" must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`);
	}
	return value as T;
}

function bool(value: unknown, key: string): boolean {
	if (typeof value !== "boolean") throw new Error(`"${key}" must be a boolean`);
	return value;
}

function text(value: unknown, key: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`"${key}" must be a non-empty string`);
	return value.trim();
}

/** Validate a parsed config file. Throws with the first problem. */
export function parseConfig(value: unknown): IntercomConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("must be a JSON object");
	const v = value as Record<string, unknown>;
	const config: IntercomConfig = { ...OFF, enabled: true, claude: { ...OFF.claude } };
	if ("enabled" in v) config.enabled = bool(v.enabled, "enabled");
	if ("brokerCommand" in v) config.brokerCommand = text(v.brokerCommand, "brokerCommand");
	if ("brokerArgs" in v) {
		if (!Array.isArray(v.brokerArgs) || v.brokerArgs.some((a) => typeof a !== "string")) {
			throw new Error(`"brokerArgs" must be an array of strings`);
		}
		config.brokerArgs = v.brokerArgs as string[];
	}
	if ("confirmSend" in v) config.confirmSend = bool(v.confirmSend, "confirmSend");
	if ("inboundTrigger" in v) config.inboundTrigger = oneOf(v.inboundTrigger, ["always", "replies", "never"], "inboundTrigger");
	if ("busyDelivery" in v) config.busyDelivery = oneOf(v.busyDelivery, ["steer", "human-first"], "busyDelivery");
	if ("replyHint" in v) config.replyHint = bool(v.replyHint, "replyHint");
	if ("status" in v) {
		if (typeof v.status !== "string") throw new Error(`"status" must be a string`);
		config.status = v.status;
	}
	if ("stableId" in v) config.stableId = text(v.stableId, "stableId");
	if ("claude" in v) {
		const c = v.claude;
		if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error(`"claude" must be an object`);
		const claude = c as Record<string, unknown>;
		if ("enabled" in claude) config.claude.enabled = bool(claude.enabled, "claude.enabled");
		if ("fromMode" in claude) config.claude.fromMode = oneOf(claude.fromMode, ["prompting", "bypass"], "claude.fromMode");
	}
	return config;
}

/** PI_INTERCOM_ASK_TIMEOUT_MS, shared with pi-subagents; a bad value falls back to the default. */
export function askTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_INTERCOM_ASK_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_ASK_TIMEOUT_MS;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_ASK_TIMEOUT_MS;
}
