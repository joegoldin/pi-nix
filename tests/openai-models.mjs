import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
assert.ok(root, "usage: node openai-models.mjs <ai directory>");
const dataDir = join(root, "providers/data");
const manifest = JSON.parse(readFileSync(join(dataDir, ".manifest.json"), "utf8"));
for (const [file, expected] of Object.entries(manifest.files)) {
	const actual = createHash("sha256").update(readFileSync(join(dataDir, file))).digest("hex");
	assert.equal(actual, expected, `${file} generation hash`);
}

assert.ok(!Object.hasOwn(manifest.files, "openai-codex.json"), "retired models must not be regenerated");
assert.ok(!existsSync(join(dataDir, "openai-codex.json")), "retired provider data must not ship");
const provider = "openai";
const api = "openai-responses";
const catalog = JSON.parse(readFileSync(join(dataDir, `${provider}.json`), "utf8"))[api];
for (const [family, previous, prices] of [
	["astra", "gpt-6-astra", { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 }],
	["sol", "gpt-6.1-sol", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
]) {
	const id = `gpt-6.2-${family}`;
	const model = catalog[`chat:${id}`];
	assert.ok(model, `${provider}/${id} is available`);
	assert.ok(catalog[`chat:${previous}`], `${provider}/${previous} remains available`);
	assert.equal(model.id, id);
	assert.equal(model.name, `GPT-6.2 ${family === "astra" ? "Astra" : "Sol"}`);
	assert.equal(model.provider, provider);
	assert.equal(model.api, api);
	assert.equal(model.maxTokens, 128000);
	assert.equal(model.contextWindow, catalog[`chat:${previous}`].contextWindow, "retain provider context policy");
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.reasoning, true);
	assert.equal(model.thinkingLevelMap.off, null, "GPT-6.2 rejects reasoning effort none");
	assert.notEqual(model.thinkingLevelMap.minimal, "minimal");
	for (const [key, price] of Object.entries(prices)) assert.equal(model.cost[key], price);
	assert.deepEqual(model.cost.tiers, [{
		inputTokensAbove: 272000,
		input: prices.input * 2,
		output: prices.output * 1.5,
		cacheRead: prices.cacheRead * 2,
		cacheWrite: prices.cacheWrite * 2,
	}]);
	for (const key of ["supportsOpenAIGrammarTools", "supportsAdditionalTools", "supportsToolSearch", "supportsMidConvoSystemMessages"]) {
		assert.equal(model.compat[key], true, `${provider}/${id} ${key}`);
	}
}
console.log("GPT-6.2 catalog metadata and model-data hashes pass");
