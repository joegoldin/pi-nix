// Priority is a request setting, not a different model or reasoning level.
// Keep the preference in the session rather than enabling paid priority globally.

interface FastModel {
	id: string;
	provider: string;
	api: string;
}

interface FastContext {
	model?: FastModel;
	sessionManager: { getBranch(): unknown[] };
	ui: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

interface FastHost {
	on(event: string, handler: (event: never, ctx: never) => unknown): void;
	registerCommand(name: string, options: { description: string; handler: (args: string, ctx: never) => Promise<void> }): void;
	appendEntry(customType: string, data: unknown): void;
}

const STATE_TYPE = "pi-fast:state";
const STATUS_KEY = "pi-fast";
const MODELS = new Set(["gpt-5.4", "gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"]);

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function supportsPriority(model: FastModel | undefined): boolean {
	if (!model || !MODELS.has(model.id)) return false;
	return (model.provider === "openai" && model.api === "openai-responses") ||
		(model.provider === "openai-codex" && model.api === "openai-codex-responses");
}

export default function register(pi: FastHost): void {
	let enabled = false;
	const publish = (ctx: FastContext) => {
		ctx.ui.setStatus(STATUS_KEY, enabled && supportsPriority(ctx.model) ? "fast" : undefined);
	};
	const restore = (_event: never, context: never) => {
		const ctx = context as FastContext;
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!record(entry) || entry.type !== "custom" || entry.customType !== STATE_TYPE || !record(entry.data)) continue;
			if (typeof entry.data.enabled === "boolean") enabled = entry.data.enabled;
		}
		publish(ctx);
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("session_compact", restore);
	pi.on("model_select", (_event, ctx) => publish(ctx));
	pi.on("session_shutdown", (_event, ctx) => (ctx as FastContext).ui.setStatus(STATUS_KEY, undefined));

	pi.registerCommand("fast", {
		description: "Toggle OpenAI priority inference for this session: /fast [on|off|toggle]. May increase cost or plan usage.",
		handler: async (args, context) => {
			const ctx = context as FastContext;
			const action = args.trim().toLowerCase();
			if (action !== "" && action !== "toggle" && action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /fast [on|off|toggle]", "warning");
				return;
			}
			const next = action === "on" ? true : action === "off" ? false : !enabled;
			if (next !== enabled) {
				pi.appendEntry(STATE_TYPE, { enabled: next });
				enabled = next;
			}
			publish(ctx);
			if (!enabled) ctx.ui.notify("Fast mode off. Subsequent requests use the normal provider settings.");
			else if (!supportsPriority(ctx.model)) {
				ctx.ui.notify("Fast mode enabled but inactive for this model. It applies only to supported OpenAI/OpenAI-Codex models and may increase cost or plan usage.", "warning");
			} else {
				ctx.ui.notify("Fast mode on for subsequent requests (priority tier; may increase cost or plan usage).");
			}
		},
	});

	pi.on("before_provider_request", (event, context) => {
		const ctx = context as FastContext;
		const { payload } = event as { payload: unknown };
		if (!enabled || !supportsPriority(ctx.model) || !record(payload) || payload.model !== ctx.model?.id) return;
		return { ...payload, service_tier: "priority" };
	});
}
