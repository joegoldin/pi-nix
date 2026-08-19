// pi-auto-mode entrypoint. Everything decidable lives in the sibling modules;
// this file only wires pi's objects into them.

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { attachAuthorizer } from "./authorizer.ts";
import { classify } from "./classifier.ts";
import { AUTO_MODE_PROMPT_CHANNEL, type AutoModeConfig, type AutoModePromptEvent, loadConfig } from "./config.ts";
import { decide, decideDeterministic } from "./gate.ts";
import { renderRequest, type ToolRequest } from "./request.ts";
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
	let delegated = false;

	const makeClassify = (ctx: ExtensionContext) => (req: ToolRequest, turns: string[]) =>
		classify(
			{
				model: resolveModel(config, ctx),
				complete: (model, context, options) =>
					ctx.modelRegistry.complete(model as never, context as never, options as never),
				signal: AbortSignal.any(
					[ctx.signal, AbortSignal.timeout(config.timeoutMs)].filter((s): s is AbortSignal => s !== undefined),
				),
			},
			config,
			req,
			turns,
		);

	const makeDeps = (ctx: ExtensionContext) => ({
		config,
		classify: makeClassify(ctx),
		userTurns: () => recentUserTurns(ctx.sessionManager, config.userTurnLimit),
		onPrompt: (payload: AutoModePromptEvent) => pi.events.emit(AUTO_MODE_PROMPT_CHANNEL, payload),
	});

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		if (!config.enabled || !config.delegateToPermissionSystem) return;
		delegated = attachAuthorizer(pi, () => makeDeps(ctx));
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		const request = renderRequest(event);
		const deps = makeDeps(ctx);
		// With pi-permission-system on the chain, the link registered above is the
		// classifier's entry point and running the full gate too would classify
		// every ask twice. The deny list still runs here: it costs no model call,
		// and it is the half that must not depend on the operator having wired the
		// other package's authorizerChain.
		if (delegated) return decideDeterministic(deps, request);
		return decide(deps, ctx, request);
	});
}
