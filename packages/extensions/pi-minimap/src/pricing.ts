import type { ReportedUsage } from "./engine.ts";
import { record } from "./state.ts";

export interface TokenRates {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	request: number;
}
const rate = (value: unknown): number | undefined => {
	if (typeof value !== "number" && (typeof value !== "string" || !value.trim()))
		return;
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : undefined;
};

/** Cerebras' OpenRouter-format model catalogue quotes USD per token, not per million. */
export function parseRates(value: unknown): Map<string, TokenRates> {
	const rates = new Map<string, TokenRates>();
	if (!record(value) || !Array.isArray(value.data)) return rates;
	for (const model of value.data) {
		if (
			!record(model) ||
			typeof model.id !== "string" ||
			!record(model.pricing)
		)
			continue;
		const input = rate(model.pricing.prompt),
			output = rate(model.pricing.completion);
		const request =
			model.pricing.request === undefined ? 0 : rate(model.pricing.request);
		if (input === undefined || output === undefined || request === undefined)
			continue;
		rates.set(model.id.replace(/^cerebras\//, ""), {
			input,
			output,
			request,
			cacheRead: rate(model.pricing.input_cache_read),
			cacheWrite: rate(model.pricing.input_cache_write),
		});
	}
	return rates;
}

export function costAtRates(
	usage: ReportedUsage,
	rates: TokenRates,
): number | undefined {
	let cost = rates.request;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		if (!usage[key]) continue;
		const price = rates[key];
		if (price === undefined) return;
		cost += usage[key] * price;
	}
	return Number.isFinite(cost) ? cost : undefined;
}

/** One metadata lookup per hour; failures back off for five minutes. Never query account billing. */
export class CerebrasRates {
	private rates = new Map<string, TokenRates>();
	private until = 0;
	private pending?: Promise<void>;
	constructor(
		private fetcher: (
			url: string,
			options: RequestInit,
		) => Promise<Response> = fetch,
		private now: () => number = Date.now,
	) {}
	async get(
		model: { provider: string; baseUrl?: string; id: string },
		key: () => Promise<string | undefined>,
		signal: AbortSignal,
	): Promise<TokenRates | undefined> {
		// A custom endpoint may use unrelated credentials and pricing. Do not forward its key.
		if (
			model.provider !== "cerebras" ||
			model.baseUrl?.replace(/\/$/, "") !== "https://api.cerebras.ai/v1"
		)
			return;
		if (signal.aborted) return;
		if (!this.pending && this.now() >= this.until) {
			this.pending = this.load(key, signal).finally(() => {
				this.pending = undefined;
			});
		}
		await this.pending;
		return this.rates.get(model.id.replace(/^cerebras\//, ""));
	}
	private async load(
		key: () => Promise<string | undefined>,
		signal: AbortSignal,
	): Promise<void> {
		this.rates.clear();
		this.until = this.now() + 5 * 60_000;
		try {
			const apiKey = await key();
			if (!apiKey || signal.aborted) return;
			const response = await this.fetcher(
				"https://api.cerebras.ai/v1/models?format=openrouter",
				{
					headers: { Authorization: `Bearer ${apiKey}` },
					signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
					redirect: "error",
				},
			);
			if (!response.ok) return;
			this.rates = parseRates(await response.json());
			if (this.rates.size) this.until = this.now() + 60 * 60_000;
		} catch {
			// Metadata is optional. Inference can still use configured prices if this endpoint is unavailable.
		}
	}
}
