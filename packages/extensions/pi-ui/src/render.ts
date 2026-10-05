// The tool-renderer resolver: which calls get a card, and how pi's two render
// slots are turned into one.
//
// pi draws a call through renderCall and its result through renderResult, as
// two components stacked in the same row. A Claude Code card is one unit, and
// compact mode needs the header and the result on the SAME line, which two
// stacked components cannot express. So the call slot draws the whole card and
// the result slot only records what it was given. Both renderers run on every
// update before anything is painted, and the card reads that record at paint
// time, so it always sees the result of the update it is painting.

import type { UiTheme } from "./card.ts";
import { CardComponent, type CardLayout } from "./card.ts";
import type { UiConfig } from "./config.ts";
import { BUILT_IN_TOOLS, buildCard, type CardDeps, type ToolResultLike } from "./tools.ts";

/** What renderResult leaves for the card. Lives in pi's per-row renderer state. */
interface RowRecord {
	result?: ToolResultLike;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
}

/** The fields of pi's ToolRenderContext this module reads. */
export interface RenderContextLike {
	args: unknown;
	state: { piUi?: RowRecord };
	cwd: string;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
}

export interface RendererDeps {
	config(): UiConfig;
	highlight: CardDeps["highlight"];
	languageOf: CardDeps["languageOf"];
	expandHint(): string;
}

/** Nothing to paint; the result's content is drawn by the call slot. */
const EMPTY = { render: () => [] as string[], invalidate() {} };

class LiveCard {
	constructor(
		private toolName: string,
		private context: RenderContextLike,
		private theme: UiTheme,
		private deps: RendererDeps,
	) {}

	render(width: number): string[] {
		const config = this.deps.config();
		const record = this.context.state.piUi;
		const model = buildCard(
			{
				toolName: this.toolName,
				args: (this.context.args ?? {}) as Record<string, unknown>,
				result: record?.result,
				isPartial: record?.isPartial ?? true,
				isError: record?.isError ?? false,
				cwd: this.context.cwd,
			},
			{ theme: this.theme, config, highlight: this.deps.highlight, languageOf: this.deps.languageOf },
		);
		const layout: CardLayout = {
			mode: config.toolMode === "compact" ? "compact" : "on",
			expanded: record?.expanded ?? this.context.expanded,
			collapsedLines: config.collapsedLines,
			expandedLines: config.expandedLines,
			expandHint: this.deps.expandHint(),
		};
		return new CardComponent(model, layout, this.theme).render(width);
	}

	invalidate(): void {}
}

export interface ToolRenderersLike {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: any, context: any) => any;
	renderResult?: (result: any, options: any, theme: any, context: any) => any;
}

export function cardRenderers(toolName: string, deps: RendererDeps): ToolRenderersLike {
	return {
		renderShell: "self",
		renderCall: (_args, theme, context: RenderContextLike) => new LiveCard(toolName, context, theme, deps),
		renderResult: (result, options: { expanded: boolean; isPartial: boolean }, _theme, context: RenderContextLike) => {
			context.state.piUi = {
				result,
				isPartial: options.isPartial,
				isError: context.isError,
				expanded: options.expanded,
			};
			return EMPTY;
		},
	};
}

/**
 * The resolver pi calls for every tool name. Built-in tools always get a card,
 * whoever registered them. Other tools keep renderers of their own (a subagent
 * or todo tool draws something a card would flatten) and only get the generic
 * card when they have none, which is every MCP tool.
 */
export function createResolver(deps: RendererDeps) {
	return (toolName: string, next: () => ToolRenderersLike | undefined): ToolRenderersLike | undefined => {
		if (deps.config().toolMode === "off") return next();
		if (BUILT_IN_TOOLS.has(toolName)) return cardRenderers(toolName, deps);
		const theirs = next();
		if (theirs?.renderCall || theirs?.renderResult) return theirs;
		return cardRenderers(toolName, deps);
	};
}
