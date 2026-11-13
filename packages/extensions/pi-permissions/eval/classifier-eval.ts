#!/usr/bin/env bun
// Live classifier evaluation: sends each sanitized case through the real
// classifier pipeline (prompt, transcript selection, staged completion) using
// Pi's own model runtime and credential store. Not part of `bun test`, because
// it calls a model provider.
//
//   bun eval/classifier-eval.ts [--settings settings.json] [--model provider/id] [--repeat N] [--only name,...]
//
// --settings takes the same JSON shape as PI_AUTOMODE_SETTINGS_JSON, so the
// operator's own rule lists can be evaluated alongside the built-in defaults.
import { readFileSync } from "node:fs";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defaultClassifyAction, serializeClassifierAction } from "../src/auto/classifier.ts";
import { buildEffectiveConfigFromSources } from "../src/auto/config.ts";
import type { SettingsFile } from "../src/auto/types.ts";
import { CASES, type EvalCase } from "./cases.ts";

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const settingsPath = option("--settings");
const inline: SettingsFile[] = [];
if (process.env.PI_AUTOMODE_SETTINGS_JSON) inline.push(JSON.parse(process.env.PI_AUTOMODE_SETTINGS_JSON));
if (settingsPath) inline.push(JSON.parse(readFileSync(settingsPath, "utf8")));
const config = buildEffectiveConfigFromSources({ inlineSettings: inline });
const model = option("--model");
if (model) config.classifierModel = model;
if (!config.classifierModel) throw new Error("No classifier model: pass --model provider/id or set autoMode.classifierModel");
const repeat = Number(option("--repeat") ?? 1);
const only = option("--only")?.split(",");

const registry = new ModelRegistry(await ModelRuntime.create());

function branch(testCase: EvalCase) {
	return testCase.turns.map((turn, index) => ({
		type: "message",
		id: `e${index}`,
		message: turn.role === "user"
			? { role: "user", content: [{ type: "text", text: turn.text }] }
			: { role: "assistant", content: [
				...(turn.text ? [{ type: "text", text: turn.text }] : []),
				...(turn.calls ?? []).map((call, order) => ({ type: "toolCall", id: `t${index}-${order}`, name: call.name, arguments: call.input })),
			] },
	}));
}

let failures = 0;
const rows: string[] = [];
for (const testCase of CASES.filter(item => !only || only.includes(item.name))) {
	for (let run = 0; run < repeat; run++) {
		const ctx = {
			cwd: testCase.cwd,
			model: undefined,
			modelRegistry: registry,
			signal: undefined,
			sessionManager: { getBranch: () => branch(testCase), getSessionId: () => `eval-${testCase.name}-${run}` },
		} as never;
		const result = await defaultClassifyAction(ctx, config, serializeClassifierAction(testCase.action.toolName, testCase.action.input), "", testCase.approvals ?? []);
		// A provider failure is neither outcome; report it instead of scoring it.
		const failed = result.decision === "block" && /fails closed/.test(result.reason);
		const pass = !failed && result.decision === testCase.expect;
		if (!pass) failures++;
		rows.push(`${failed ? "ERROR" : pass ? "pass " : "FAIL "} ${testCase.expect.padEnd(5)} -> ${result.decision}/${result.tier}  ${testCase.name}\n        ${result.reason.replace(/\s+/g, " ").slice(0, 1200)}`);
		console.log(rows.at(-1));
	}
}
console.log(`\n${rows.length - failures}/${rows.length} matched expectations with ${config.classifierModel}`);
process.exitCode = failures ? 1 : 0;
