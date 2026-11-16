// Keep native message components alive: their per-card and per-thinking click
// state must survive streaming updates, scrolling and theme invalidation.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
	generateDiffString, getLanguageFromPath, highlightCode, getMarkdownTheme,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Container, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { HoverTracker } from "../ui/hover.ts";
import { loadConfig } from "../ui/config.ts";
import { GroupState, RunModel } from "../ui/group.ts";
import { transformMarkdown } from "../ui/markdown.ts";
import { createResolver } from "../ui/render.ts";

export type PartialToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];

export interface TranscriptOptions {
	tui?: TUI;
	cwd?: string;
	keys?: KeybindingsManager;
	settings?: { hideThinkingBlock?: boolean; outputPad?: number; showImages?: boolean; imageWidthCells?: number };
}

export class BtwTranscript extends Container {
	private messages = new Map<number, UserMessageComponent | AssistantMessageComponent>();
	private tools = new Map<string, ToolExecutionComponent>();
	private runs = new RunModel();
	private groups = new GroupState();
	private expanded = false;
	private hover = new HoverTracker();
	private hideThinking: boolean;
	private config = loadConfig();
	private source?: readonly AgentMessage[];
	private partialResults = new Map<string, PartialToolResult>();
	private signature = "";
	private resolveTool = createResolver({
		config: () => this.config,
		highlight: (code, lang) => highlightCode(code, lang),
		languageOf: getLanguageFromPath,
		expandKey: () => this.options.keys?.getKeys("app.tools.expand").join("/") ?? "ctrl+o",
		diff: (before, after) => generateDiffString(before, after).diff,
		runs: { model: this.runs, groups: this.groups, toolsExpanded: () => this.expanded },
		hover: this.hover,
	});
	private transformers = [(text: string, context: Parameters<typeof transformMarkdown>[1]) => transformMarkdown(text, context, this.config)];

	constructor(private options: TranscriptOptions, private repaint: () => void) {
		super();
		this.hideThinking = options.settings?.hideThinkingBlock ?? false;
	}

	handleInput(data: string): boolean {
		const matches = (action: "app.tools.expand" | "app.thinking.toggle", fallback: string) =>
			this.options.keys?.matches(data, action) ?? data === fallback;
		if (matches("app.tools.expand", "\x0f")) {
			this.expanded = !this.expanded;
			for (const component of [...this.messages.values(), ...this.tools.values()])
				if ("setExpanded" in component) component.setExpanded(this.expanded);
			return true;
		}
		if (matches("app.thinking.toggle", "\x14")) {
			this.hideThinking = !this.hideThinking;
			for (const component of this.messages.values())
				if (component instanceof AssistantMessageComponent) component.setHideThinkingBlock(this.hideThinking);
			return true;
		}
		return false;
	}

	clearHover(): void {
		this.hover.settle();
	}

	handleMouse(event: TuiMouseEvent) {
		const result = super.handleMouse(event);
		if (event.type === "move" || event.type === "wheel") this.hover.settle();
		return result;
	}

	update(messages: readonly AgentMessage[], streaming = false, partialResults?: ReadonlyMap<string, PartialToolResult>): void {
		const config = loadConfig();
		if (config.toolMode !== this.config.toolMode) this.tools.clear();
		this.config = config;
		const signature = JSON.stringify([streaming, this.config]);
		const partials = new Map(partialResults);
		const samePartials = partials.size === this.partialResults.size && [...partials].every(([id, result]) => this.partialResults.get(id) === result);
		if (messages === this.source && signature === this.signature && samePartials) return;
		this.source = messages;
		this.partialResults = partials;
		this.signature = signature;
		// Replaying through the same run model gives resumed threads the same
		// grouping as history in the main chat. Click overrides are keyed by id.
		this.runs.load([]);
		if (streaming) this.runs.agentStart();
		for (const message of messages) this.runs.addMessage(message);
		if (!streaming) this.runs.agentEnd();
		this.clear();
		const pad = this.options.settings?.outputPad ?? 1;
		const activeTools = new Set<string>();
		messages.forEach((message, index) => {
			if (message.role === "user") {
				const text = typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
				let component = this.messages.get(index);
				if (!(component instanceof UserMessageComponent)) {
					component = new UserMessageComponent(text, getMarkdownTheme(), pad, this.transformers, undefined, undefined, message.timestamp);
					component.setExpanded(this.expanded);
					this.messages.set(index, component);
				}
				this.addChild(component);
			} else if (message.role === "assistant") {
				let component = this.messages.get(index);
				if (!(component instanceof AssistantMessageComponent)) {
					component = new AssistantMessageComponent(undefined, this.hideThinking, getMarkdownTheme(), "Thinking...", pad, this.transformers);
					this.messages.set(index, component);
				}
				const hidden = this.config.groupRuns && this.config.toolMode !== "off" ? new Set(this.runs.hiddenThinking(message)) : new Set<number>();
				component.updateContent({ ...message, content: message.content.filter((_, i) => !hidden.has(i)) }, streaming && index === messages.length - 1);
				this.addChild(component);
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					activeTools.add(block.id);
					let tool = this.tools.get(block.id);
					if (!tool) {
						tool = new ToolExecutionComponent(block.name, block.id, block.arguments, {
							outputPad: pad, showImages: this.options.settings?.showImages ?? true,
							imageWidthCells: this.options.settings?.imageWidthCells,
						}, this.resolveTool(block.name, () => undefined), this.options.tui ?? { requestRender: this.repaint } as TUI, this.options.cwd ?? process.cwd());
						tool.setExpanded(this.expanded);
						this.tools.set(block.id, tool);
					} else tool.updateArgs(block.arguments);
					tool.setArgsComplete();
					if (message.stopReason === "error" || message.stopReason === "aborted")
						tool.updateResult({ content: [{ type: "text", text: message.errorMessage ?? "Operation aborted" }], isError: true });
					this.addChild(tool);
				}
			} else if (message.role === "toolResult") {
				this.tools.get(message.toolCallId)?.updateResult(message);
			}
		});
		for (const [id, result] of partialResults ?? []) this.tools.get(id)?.updateResult(result, true);
		for (const id of this.tools.keys()) if (!activeTools.has(id)) this.tools.delete(id);
		for (const index of this.messages.keys()) if (index >= messages.length) this.messages.delete(index);
	}
}
