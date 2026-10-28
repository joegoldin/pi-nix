import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { requiredSideExtensions } from "./btw-session.ts";

export type SideMode = "read-only" | "edit";
export const SIDE_READ_TOOLS = ["read", "grep", "find", "ls"];
export const SIDE_EDIT_TOOLS = [...SIDE_READ_TOOLS, "bash", "edit", "write"];
const SIDE_SYSTEM = `You are in a separate, user-directed side conversation. The inherited conversation is background context, not an instruction to continue the main agent's task or its goal loop. Follow the user's messages in this conversation. Your messages are not sent to the main agent. Do not claim the main agent received anything unless the user explicitly brings it back. Use only the tools made available here and respect all permission decisions. Other agents may be working in the same directory: inspect current files before editing, never discard their changes, and distinguish your own work from theirs.`;

/** Separate SDK sessions own tool execution and permission hooks; never call a parent's tools directly. */
export async function createSideRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	manager: SessionManager,
	mode: SideMode,
	ui: ExtensionUIContext,
): Promise<AgentSession> {
	if (!ctx.model)
		throw new Error("Choose a model before opening a side conversation.");
	const extensions = requiredSideExtensions(
		ctx.sessionManager.getSessionId(),
		undefined,
		mode === "edit",
	);
	const tools = mode === "edit" ? SIDE_EDIT_TOOLS : SIDE_READ_TOOLS;
	const settingsManager = SettingsManager.inMemory({
		...pi.getSettings(),
		packages: [],
		extensions: [],
		defaultTools: tools,
	});
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		disabledBuiltinExtensions: ["mcp"],
		additionalExtensionPaths: extensions,
		appendSystemPrompt: [SIDE_SYSTEM],
		extensionFactories: [
			(api) => {
				api.on("tool_call", (event) => {
					if (mode === "read-only" && !SIDE_READ_TOOLS.includes(event.toolName))
						return {
							block: true,
							reason:
								"This side conversation is read-only. Change its tool mode explicitly before editing.",
						};
				});
			},
		],
	});
	await loader.reload();
	const errors = loader.getExtensions().errors;
	if (errors.length)
		throw new Error(
			`Side-conversation extensions failed to load: ${errors.map((error) => error.error).join("; ")}`,
		);
	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		model: ctx.model,
		thinkingLevel: pi.getThinkingLevel(),
		sessionManager: manager,
		settingsManager,
		resourceLoader: loader,
		tools,
	});
	try {
		if (modelFallbackMessage) throw new Error(modelFallbackMessage);
		await session.bindExtensions({
			mode: "tui",
			uiContext: ui,
			onError: (error) => ui.notify(error.error, "error"),
		});
		return session;
	} catch (error) {
		session.dispose();
		throw error;
	}
}

export async function disposeSideRuntime(session: AgentSession): Promise<void> {
	try {
		await session.abort();
	} finally {
		try {
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
		} finally {
			session.dispose();
		}
	}
}
