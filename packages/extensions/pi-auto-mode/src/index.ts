// pi-auto-mode entrypoint. Everything decidable lives in the sibling modules;
// this file only wires pi's objects into them.

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { classify } from "./classifier.ts";
import { AUTO_MODE_PROMPT_CHANNEL, type AutoModeConfig, loadConfig } from "./config.ts";
import { decide } from "./gate.ts";
import { renderRequest } from "./request.ts";
import { recentUserTurns } from "./session.ts";

function resolveModel(config: AutoModeConfig, ctx: ExtensionContext): unknown {
	if (config.classifierModel !== null) {
		const found = ctx.modelRegistry.find(config.classifierModel.provider, config.classifierModel.modelId);
		if (found !== undefined) return found;
	}
	return ctx.model ?? null;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig((path) => readFileSync(path, "utf8"), process.env);

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		const request = renderRequest(event);
		return decide(
			{
				config,
				userTurns: () => recentUserTurns(ctx.sessionManager, config.userTurnLimit),
				onPrompt: (payload) => pi.events.emit(AUTO_MODE_PROMPT_CHANNEL, payload),
				classify: (req, turns) =>
					classify(
						{
							model: resolveModel(config, ctx),
							complete: (model, context, options) =>
								ctx.modelRegistry.complete(model as never, context as never, options as never),
							signal: AbortSignal.any(
								[ctx.signal, AbortSignal.timeout(config.timeoutMs)].filter(
									(s): s is AbortSignal => s !== undefined,
								),
							),
						},
						config,
						req,
						turns,
					),
			},
			ctx,
			request,
		);
	});
}
