import { readStoredCredential, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const USAGE_REPORT_CHANNEL = "pi-custom:usage-report";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 64 * 1024;
const PROVIDERS = new Set(["openai", "openai-codex", "openai-chatgpt"]);

type ObjectValue = Record<string, unknown>;
type RequestAuth = { apiKey?: string; headers?: Record<string, string | null | undefined>; baseUrl?: string };
export interface UsageReport {
	providerId: string;
	providerName: string;
	capturedAt: number;
	source: string;
	semantics: { kind: "consumer-subscription"; label: string };
	buckets: { id: string; label: string; groupId: string; unit: "percent"; used: number; windowMinutes: number; resetsAt?: number }[];
	metrics: never[];
}
interface QueryOptions {
	signal: AbortSignal;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	readCredential?: (provider: string) => unknown;
	events?: Pick<ExtensionAPI["events"], "emit">;
}
class UsageUnavailable extends Error {}

function object(value: unknown): ObjectValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

function bearer(auth: RequestAuth): string | undefined {
	const headers = Object.entries(auth.headers ?? {}).filter(([key]) => key.toLowerCase() === "authorization");
	if (headers.length > 1) return undefined;
	if (headers.length === 1) return typeof headers[0]![1] === "string" ? /^Bearer (\S+)$/i.exec(headers[0]![1])?.[1] : undefined;
	return auth.apiKey && !/\s/.test(auth.apiKey) ? auth.apiKey : undefined;
}

function officialOrigin(value: string | undefined, expected: string): boolean {
	if (!value) return true;
	try { const url = new URL(value); return url.origin === expected && !url.username && !url.password; }
	catch { return false; }
}

function accountId(access: string): string {
	try {
		const claims = object(JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")));
		const id = object(claims?.["https://api.openai.com/auth"])?.chatgpt_account_id;
		if (typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\s\x00-\x1f]/.test(id)) return id;
	} catch { /* Only the runtime's Codex token may supply the account selector. */ }
	throw new UsageUnavailable("Codex account identity is unavailable; reconnect with /login openai-codex.");
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let abort: () => void = () => {};
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		})]);
	} finally { signal.removeEventListener("abort", abort); }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
	if (!response.ok) {
		await response.body?.cancel();
		throw new UsageUnavailable(`Usage query failed (HTTP ${response.status}); no quota was inferred.`);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new UsageUnavailable("Usage response was empty.");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await bounded(reader.read(), signal);
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > MAX_BYTES) throw new UsageUnavailable("Usage response exceeded the size limit.");
			chunks.push(next.value);
		}
		try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
		catch { throw new UsageUnavailable("Usage response was not valid JSON."); }
	} finally { await reader.cancel().catch(() => {}); }
}

function nativeClientId(ctx: ExtensionContext, access: string, options: QueryOptions): string {
	const ids = new Set<string>();
	let collecting = true;
	const offer = (value: unknown) => {
		if (!collecting) return;
		const credential = object(value);
		if (credential?.type !== "oauth" || credential.access !== access) return;
		if (typeof credential.clientId !== "string" || !credential.clientId.trim()) return;
		if (!Array.isArray(credential.scopes) || !credential.scopes.includes("chatgpt.tokens.use.direct")) return;
		ids.add(credential.clientId);
	};
	try {
		options.events?.emit("oauth:credential-source:v1", { session: ctx.sessionManager, provider: ctx.model!.provider, offer });
		offer((options.readCredential ?? readStoredCredential)(ctx.model!.provider));
	} finally { collecting = false; }
	if (ids.size !== 1) throw new UsageUnavailable("The native ChatGPT registration could not be matched to the current login.");
	return [...ids][0]!;
}

/** GET-only account reporting. Native OpenAI tokens never go to the legacy Codex endpoint. */
export async function queryOpenAIUsage(ctx: ExtensionContext, options: QueryOptions): Promise<UsageReport> {
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]);
	signal.throwIfAborted();
	const model = ctx.model;
	if (!model || !PROVIDERS.has(model.provider) || !ctx.modelRegistry.isUsingOAuth(model)) {
		throw new UsageUnavailable("Monthly plan reporting requires an OpenAI subscription login, not an API key.");
	}
	const codex = model.provider === "openai-codex";
	const origin = codex ? "https://chatgpt.com" : "https://api.openai.com";
	if (!officialOrigin(model.baseUrl, origin)) throw new UsageUnavailable("Usage is unavailable for a custom API origin.");

	const providerAuth = async (provider: string) => {
		try { return await bounded(ctx.modelRegistry.getProviderAuth(provider), signal); }
		catch {
			signal.throwIfAborted();
			throw new UsageUnavailable(`Unable to refresh the ${provider} login; reconnect with /login ${provider}.`);
		}
	};

	const resolve = async () => {
		signal.throwIfAborted();
		const provider = await providerAuth(model.provider);
		const active = await bounded(ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
		if (provider?.source !== "OAuth" || !active.ok || !officialOrigin(active.baseUrl, origin)) {
			throw new UsageUnavailable("The current runtime authentication is not an eligible OAuth login.");
		}
		const access = bearer(provider.auth);
		if (!access || access !== bearer(active)) throw new UsageUnavailable("Model authentication differs from the current provider login.");
		if (codex) return { access, native: access };
		// A registered custom Codex provider could issue credentials for another service.
		const custom = ctx.modelRegistry.getRegisteredNativeProvider?.("openai-codex");
		const config = ctx.modelRegistry.getRegisteredProviderConfig?.("openai-codex");
		if (custom || !officialOrigin(config?.baseUrl, "https://chatgpt.com")) throw new UsageUnavailable("The companion must use the standard Codex provider.");
		const companion = await providerAuth("openai-codex");
		const companionAccess = companion?.source === "OAuth" ? bearer(companion.auth) : undefined;
		if (!companionAccess) throw new UsageUnavailable("Numerical ChatGPT usage needs a matching /login openai-codex companion; native OpenAI login alone exposes no quota here.");
		return { access: companionAccess, native: access };
	};
	const auth = await resolve();
	const account = accountId(auth.access);
	const clientId = codex ? undefined : nativeClientId(ctx, auth.native, options);
	const check = async () => {
		const current = await resolve();
		if (current.access !== auth.access || current.native !== auth.native) throw new UsageUnavailable("Login changed while reading usage; retrying on the next refresh.");
		if (!codex && nativeClientId(ctx, current.native, options) !== clientId) throw new UsageUnavailable("ChatGPT registration changed while reading usage.");
		signal.throwIfAborted();
	};
	const read = async (url: string) => {
		await check();
		const response = await bounded((options.fetch ?? fetch)(url, {
			method: "GET", redirect: "error", signal,
			headers: { Authorization: `Bearer ${auth.access}`, "ChatGPT-Account-Id": account, Accept: "application/json" },
		}), signal);
		const value = await readJson(response, signal);
		await check();
		return object(value);
	};
	if (clientId) {
		const apps = await read(`${USAGE_URL}/chatpass/apps`);
		if (!Array.isArray(apps?.items) || apps.items.length > 100 || Object.keys(apps).some((key) => !["items", "has_more", "next_cursor"].includes(key)) || apps.items.some((item) => typeof object(item)?.id !== "string" || !(object(item)!.id as string).trim()) || (apps.has_more !== undefined && apps.has_more !== false) || (apps.next_cursor != null && apps.next_cursor !== "") || apps.items.filter((item) => object(item)?.id === clientId).length !== 1) {
			throw new UsageUnavailable("The companion account has no unique matching ChatGPT registration; its totals were not used.");
		}
	}
	const data = await read(USAGE_URL);
	const buckets: UsageReport["buckets"] = [];
	const addGroup = (raw: unknown, groupId: string) => {
		const limits = object(raw);
		for (const position of ["primary", "secondary"] as const) {
			const window = object(limits?.[`${position}_window`]);
			if (!window) continue;
			const used = window.used_percent, remaining = window.remaining_percent, seconds = window.limit_window_seconds, reset = window.reset_at;
			if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100 || typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) continue;
			if (remaining !== undefined && (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 100 || Math.abs(used + remaining - 100) > 1)) continue;
			if (reset !== undefined && (typeof reset !== "number" || !Number.isSafeInteger(reset) || reset <= 0)) continue;
			buckets.push({ id: `${groupId}:${position}`, label: "Subscription limit", groupId, unit: "percent", used, windowMinutes: seconds / 60, ...(typeof reset === "number" ? { resetsAt: reset } : {}) });
		}
	};
	addGroup(data?.rate_limit, "codex");
	// Extra model-specific caps are not the account total. Use the main plan windows.
	if (!buckets.length) throw new UsageUnavailable("The provider supplied no usable quota windows.");
	return { providerId: model.provider, providerName: "OpenAI", capturedAt: Date.now(), source: codex ? "pi-custom-codex" : "pi-custom-chatgpt-companion", semantics: { kind: "consumer-subscription", label: "ChatGPT account limits" }, buckets, metrics: [] };
}

interface UsageDeps {
	query?: typeof queryOpenAIUsage;
	schedule?: (callback: () => void, delay: number) => () => void;
}

export function registerUsage(pi: ExtensionAPI, deps: UsageDeps = {}): void {
	const query = deps.query ?? queryOpenAIUsage;
	const schedule = deps.schedule ?? ((callback, delay) => {
		const timer = setTimeout(callback, delay);
		timer.unref?.();
		return () => clearTimeout(timer);
	});
	let controller: AbortController | undefined;
	let cancelTimer: (() => void) | undefined;
	let generation = 0;
	const clear = () => { generation++; controller?.abort(); cancelTimer?.(); cancelTimer = undefined; };
	const start = async (ctx: ExtensionContext): Promise<string | undefined> => {
		clear();
		pi.events.emit(USAGE_REPORT_CHANNEL, { report: undefined });
		if (ctx.mode !== "tui") return "Account usage reporting is available in interactive Pi sessions.";
		if (!ctx.model || !PROVIDERS.has(ctx.model.provider)) return "Select an OpenAI subscription model to read its account usage.";
		const owner = generation;
		controller = new AbortController();
		const signal = controller.signal;
		const refresh = async (): Promise<string | undefined> => {
			try {
				const report = await query(ctx, { signal, events: pi.events });
				if (owner !== generation || signal.aborted) return;
				pi.events.emit(USAGE_REPORT_CHANNEL, { report });
				const windows = report.buckets.map((bucket) => {
					const minutes = bucket.windowMinutes;
					const label = minutes >= 28 * 1440 && minutes <= 31 * 1440 ? "Monthly" : minutes >= 1440 ? `${minutes / 1440}d` : `${minutes / 60}h`;
					return `${label}: ${bucket.used}% used.`;
				});
				if (!report.buckets.some((bucket) => bucket.windowMinutes >= 28 * 1440 && bucket.windowMinutes <= 31 * 1440)) windows.push("No monthly quota was reported; shorter windows are not a monthly total.");
				return windows.join("\n") + `\nSource: ${report.source === "pi-custom-codex" ? "Codex account" : "Codex companion matched to your ChatGPT registration (experimental)"}.`;
			} catch (error) {
				if (owner !== generation || signal.aborted) return;
				pi.events.emit(USAGE_REPORT_CHANNEL, { report: undefined });
				return error instanceof UsageUnavailable ? error.message : "Usage is unavailable: the account query failed or timed out.";
			} finally {
				if (owner === generation && !signal.aborted) cancelTimer = schedule(() => { void refresh(); }, REFRESH_MS);
			}
		};
		return refresh();
	};
	pi.on("session_start", (_event, ctx) => { void start(ctx); });
	pi.on("model_select", (_event, ctx) => { void start(ctx); });
	pi.on("session_shutdown", () => { clear(); pi.events.emit(USAGE_REPORT_CHANNEL, { report: undefined }); });
	pi.registerCommand("usage", {
		description: "Refresh and show read-only OpenAI account usage",
		handler: async (_args, ctx) => { const message = await start(ctx); if (message) ctx.ui.notify(message, "info"); },
	});
}
