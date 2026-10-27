import { expect, test } from "bun:test";
import { CerebrasRates, costAtRates, parseRates } from "./pricing.ts";
const catalogue = {
	data: [
		{
			id: "cerebras/qwen-test",
			pricing: {
				prompt: "0.0000006",
				completion: "0.0000012",
				input_cache_read: "0.0000001",
			},
		},
	],
};
const model = {
	provider: "cerebras",
	baseUrl: "https://api.cerebras.ai/v1",
	id: "qwen-test",
};
const signal = () => new AbortController().signal;

test("provider rates are per token, with separate cache rates and no double counting", () => {
	const rates = parseRates(catalogue).get("qwen-test")!;
	expect(
		costAtRates(
			{ input: 1000, output: 100, cacheRead: 500, cacheWrite: 0 },
			rates,
		),
	).toBeCloseTo(0.00077, 10);
	expect(
		costAtRates(
			{ input: 1000, output: 100, cacheRead: 0, cacheWrite: 1 },
			rates,
		),
	).toBeUndefined();
	expect(
		parseRates({
			data: [{ id: "bad", pricing: { prompt: "", completion: "-1" } }],
		}).size,
	).toBe(0);
	expect(
		costAtRates(
			{ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
			{ input: 0, output: 0, request: 0 },
		),
	).toBe(0);
});

test("catalogue requests coalesce and cached rates expire after one hour", async () => {
	let calls = 0,
		time = 1000;
	const cache = new CerebrasRates(
		async (url, options) => {
			calls++;
			expect(url).toBe("https://api.cerebras.ai/v1/models?format=openrouter");
			expect(options.redirect).toBe("error");
			expect(options.headers).toEqual({ Authorization: "Bearer fixture-key" });
			return Response.json(catalogue);
		},
		() => time,
	);
	const key = async () => "fixture-key";
	const [a, b] = await Promise.all([
		cache.get(model, key, signal()),
		cache.get(model, key, signal()),
	]);
	expect(a).toEqual(b);
	expect(calls).toBe(1);
	time += 59 * 60_000;
	await cache.get(model, key, signal());
	expect(calls).toBe(1);
	time += 60_001;
	await cache.get(model, key, signal());
	expect(calls).toBe(2);
});

test("failed lookups back off; other providers, custom endpoints and cancelled work never send credentials", async () => {
	let calls = 0,
		keys = 0,
		time = 1000;
	const cache = new CerebrasRates(
		async () => {
			calls++;
			return new Response(null, { status: 403 });
		},
		() => time,
	);
	const key = async () => {
		keys++;
		return "fixture-key";
	};
	await cache.get({ ...model, provider: "openai" }, key, signal());
	await cache.get(
		{ ...model, baseUrl: "https://proxy.example/v1" },
		key,
		signal(),
	);
	const aborted = new AbortController();
	aborted.abort();
	await cache.get(model, key, aborted.signal);
	expect(keys).toBe(0);
	expect(calls).toBe(0);
	expect(await cache.get(model, key, signal())).toBeUndefined();
	await cache.get(model, key, signal());
	expect(calls).toBe(1);
	time += 5 * 60_000;
	await cache.get(model, key, signal());
	expect(calls).toBe(2);
});
