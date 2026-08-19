// Same env-var channel as pi-auto-mode, for the same reason: ExtensionContext
// exposes no settings reader. The notifier path is absolute and baked by Nix, so
// nothing here searches PATH.
//
// Unlike pi-auto-mode, a malformed config DISABLES this extension. A broken
// classifier that fails open is a security hole; a broken notifier that fires
// anyway is noise, and silence is the safer default for a cosmetic feature.

export type NotifierStyle = "notify-send" | "terminal-notifier" | "osascript";

export interface NotifyEvents {
	permissionPrompt: boolean;
	agentSettled: boolean;
	longToolCall: boolean;
}

export interface NotifyConfig {
	enabled: boolean;
	/** Absolute path to the notifier binary, resolved at build time. */
	notifier: string;
	style: NotifierStyle;
	events: NotifyEvents;
	longToolCallThresholdMs: number;
	appName: string;
	/** Close the permission notification once the ask has been answered. */
	dismissOnResolve: boolean;
	/**
	 * Absolute path to the D-Bus client that closes a notify-send notification,
	 * resolved at build time. Empty means the module baked none in, and a
	 * notify-send notification then lives until it times out.
	 */
	dismisser: string;
}

export const DEFAULT_CONFIG: NotifyConfig = {
	enabled: false,
	notifier: "",
	style: "notify-send",
	events: { permissionPrompt: true, agentSettled: true, longToolCall: true },
	longToolCallThresholdMs: 30000,
	appName: "pi",
	dismissOnResolve: true,
	dismisser: "",
};

const STYLES = new Set<NotifierStyle>(["notify-send", "terminal-notifier", "osascript"]);

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function loadConfig(read: (path: string) => string, env: Record<string, string | undefined>): NotifyConfig {
	const path = env.PI_NOTIFY_CONFIG;
	if (path === undefined || path === "") return { ...DEFAULT_CONFIG };

	let parsed: unknown;
	try {
		parsed = JSON.parse(read(path));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ...DEFAULT_CONFIG };

	const o = parsed as Record<string, unknown>;
	const events = (typeof o.events === "object" && o.events !== null ? o.events : {}) as Record<string, unknown>;
	const style =
		typeof o.style === "string" && STYLES.has(o.style as NotifierStyle)
			? (o.style as NotifierStyle)
			: DEFAULT_CONFIG.style;
	const threshold =
		typeof o.longToolCallThresholdMs === "number" &&
		Number.isFinite(o.longToolCallThresholdMs) &&
		o.longToolCallThresholdMs > 0
			? Math.floor(o.longToolCallThresholdMs)
			: DEFAULT_CONFIG.longToolCallThresholdMs;

	return {
		enabled: o.enabled === true,
		notifier: typeof o.notifier === "string" ? o.notifier : DEFAULT_CONFIG.notifier,
		style,
		events: {
			permissionPrompt: bool(events.permissionPrompt, DEFAULT_CONFIG.events.permissionPrompt),
			agentSettled: bool(events.agentSettled, DEFAULT_CONFIG.events.agentSettled),
			longToolCall: bool(events.longToolCall, DEFAULT_CONFIG.events.longToolCall),
		},
		longToolCallThresholdMs: threshold,
		appName: typeof o.appName === "string" && o.appName !== "" ? o.appName : DEFAULT_CONFIG.appName,
		dismissOnResolve: bool(o.dismissOnResolve, DEFAULT_CONFIG.dismissOnResolve),
		dismisser: typeof o.dismisser === "string" ? o.dismisser : DEFAULT_CONFIG.dismisser,
	};
}
