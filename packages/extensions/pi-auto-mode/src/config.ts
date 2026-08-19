// Configuration arrives by environment variable, not settings.json.
//
// Verified against pi 0.84.2: ExtensionContext exposes no settings reader, and
// upstream pi.nix jq-merges settings.json into the user's config dir at launch
// rather than symlinking a store file. So the Nix module writes a store JSON and
// exports PI_AUTO_MODE_CONFIG through the existing `environment` option.
//
// Two failure modes, deliberately different:
//   unset or unreadable -> disabled. pi's native behaviour is no permission
//     layer at all, so an unconfigured install must not brick.
//   present but malformed -> ENABLED with empty deterministic rules, so every
//     call reaches the classifier. Design §9: a broken configuration must never
//     silently widen permissions.

import type { DeterministicRules } from "./rules.ts";
import type { AutoModeRules } from "./classifier.ts";

export interface AutoModeConfig extends AutoModeRules {
	enabled: boolean;
	deterministic: DeterministicRules;
	/** null means "use the session's own model". */
	classifierModel: { provider: string; modelId: string } | null;
	userTurnLimit: number;
	delegateToPermissionSystem: boolean;
	timeoutMs: number;
}

export const DEFAULT_CONFIG: AutoModeConfig = {
	enabled: false,
	allow: [],
	soft_deny: [],
	hard_deny: [],
	environment: [],
	deterministic: { allow: [], deny: [] },
	classifierModel: null,
	userTurnLimit: 6,
	delegateToPermissionSystem: false,
	timeoutMs: 20000,
};

export const AUTO_MODE_PROMPT_CHANNEL = "pi-auto-mode:prompt";

export interface AutoModePromptEvent {
	toolName: string;
	toolCallId: string;
	value: string;
	detail: string;
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function modelRef(value: unknown): { provider: string; modelId: string } | null {
	if (typeof value !== "object" || value === null) return null;
	const { provider, modelId } = value as Record<string, unknown>;
	if (typeof provider !== "string" || typeof modelId !== "string") return null;
	if (provider === "" || modelId === "") return null;
	return { provider, modelId };
}

/** Fail-closed shape: enabled, but with nothing pre-approved. */
const FAIL_CLOSED: AutoModeConfig = { ...DEFAULT_CONFIG, enabled: true };

export function loadConfig(read: (path: string) => string, env: Record<string, string | undefined>): AutoModeConfig {
	const path = env.PI_AUTO_MODE_CONFIG;
	if (path === undefined || path === "") return { ...DEFAULT_CONFIG, enabled: false };

	let raw: string;
	try {
		raw = read(path);
	} catch {
		return { ...DEFAULT_CONFIG, enabled: false };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ...FAIL_CLOSED };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ...FAIL_CLOSED };
	}

	const o = parsed as Record<string, unknown>;
	const det = (typeof o.deterministic === "object" && o.deterministic !== null ? o.deterministic : {}) as Record<
		string,
		unknown
	>;

	return {
		enabled: o.enabled === undefined ? DEFAULT_CONFIG.enabled : o.enabled === true,
		allow: strings(o.allow),
		soft_deny: strings(o.soft_deny),
		hard_deny: strings(o.hard_deny),
		environment: strings(o.environment),
		deterministic: { allow: strings(det.allow), deny: strings(det.deny) },
		classifierModel: modelRef(o.classifierModel),
		userTurnLimit: positiveInt(o.userTurnLimit, DEFAULT_CONFIG.userTurnLimit),
		delegateToPermissionSystem: o.delegateToPermissionSystem === true,
		timeoutMs: positiveInt(o.timeoutMs, DEFAULT_CONFIG.timeoutMs),
	};
}
