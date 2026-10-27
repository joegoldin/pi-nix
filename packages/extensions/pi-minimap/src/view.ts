import {
	HStack,
	ScrollView,
	VStack,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { MinimapEngine } from "./engine.ts";
import {
	earlierBullets,
	type Beat,
	type EventKind,
	type Snapshot,
	type Usage,
} from "./state.ts";

export interface Palette {
	fg(
		slot:
			| "text"
			| "muted"
			| "accent"
			| "success"
			| "warning"
			| "error"
			| "border"
			| "customMessageLabel",
		text: string,
	): string;
	bg(slot: "selectedBg", text: string): string;
	bold(text: string): string;
}
export interface ViewActions {
	switchModel(): void;
	jump(id: string): void;
	status(): string;
	contains(beat: Beat, id: string): boolean;
	render(): void;
	rows(): number;
}
const number = (value: number) =>
	value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
export function usageRows(usage: Usage): string[] {
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	const tokens = `${number(input)} in · ${number(usage.output)} out${usage.unknownTokens ? " + ?" : ""}`;
	const known = usage.requests - usage.unknownCost;
	const cost =
		known > 0
			? `est. $${usage.cost.toFixed(4)}${usage.unknownCost ? " + ?" : ""}`
			: "cost unavailable";
	return [tokens, `${usage.requests} calls · ${cost}`];
}

export function purposeRows(
	state: Pick<Snapshot, "now" | "focus">,
	width: number,
): string[] {
	if (!state.focus?.length)
		return wrapTextWithAnsi(
			state.now || "Observing this conversation.",
			width,
		).slice(0, 4);
	return state.focus
		.flatMap((topic) => [
			truncateToWidth(`• ${topic.topic}`, width, "…"),
			...topic.subtopics.map((text, index) =>
				truncateToWidth(
					`  ${index === topic.subtopics.length - 1 ? "└" : "├"} ${text}`,
					width,
					"…",
				),
			),
		])
		.slice(0, 4);
}
export function relativeAge(at: number | undefined, now = Date.now()): string {
	if (at === undefined || !Number.isFinite(at) || at <= 0) return "";
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
const kinds: Record<
	EventKind,
	{ mark: string; slot: Parameters<Palette["fg"]>[0] }
> = {
	ask: { mark: "?", slot: "accent" },
	decision: { mark: "◆", slot: "customMessageLabel" },
	change: { mark: "•", slot: "success" },
	check: { mark: "◇", slot: "accent" },
	blocker: { mark: "!", slot: "warning" },
	note: { mark: "·", slot: "text" },
};
type Row = { text: string; beat?: Beat };
class Log implements Component {
	rows: Row[] = [];
	width = 36;
	private hover?: string;
	constructor(
		private engine: MinimapEngine,
		private theme: Palette,
		private actions: ViewActions,
	) {}
	invalidate() {}
	clearHover(): boolean {
		const had = this.hover !== undefined;
		this.hover = undefined;
		return had;
	}
	render(width: number): string[] {
		this.width = width;
		// Auto scrollbars overlay the last column rather than reserving it.
		const contentWidth = Math.max(1, width - 1);
		const state = this.engine.state;
		const rows: Row[] = [];
		const section = (label: string, beats: Beat[], older = false) => {
			if (!beats.length) return;
			rows.push({ text: this.theme.fg("muted", label) });
			for (const beat of beats) {
				const kind = kinds[beat.kind ?? "note"];
				const slot =
					beat.tone === "neutral" ? (older ? "muted" : kind.slot) : beat.tone;
				if (beat.recap)
					rows.push({
						text: this.theme.fg(
							"accent",
							beat.omitted
								? `↻ Recap · ${number(beat.omitted)} events omitted`
								: "↻ Recap · catch-up",
						),
						beat,
					});
				const mark =
					beat.tone === "success"
						? "✓"
						: beat.tone === "warning"
							? "!"
							: beat.tone === "error"
								? "×"
								: kind.mark;
				const age = relativeAge(beat.at);
				let extraAge = false;
				const lines = wrapTextWithAnsi(
					beat.text,
					Math.max(1, contentWidth - 2),
				);
				lines.forEach((line, index) => {
					let text = this.theme.fg(slot, `${index ? " " : mark} ${line}`);
					if (age && index === lines.length - 1) {
						const padding =
							contentWidth - visibleWidth(text) - visibleWidth(age);
						if (padding >= 2)
							text += " ".repeat(padding) + this.theme.fg("muted", age);
						else extraAge = true;
					}
					if (this.hover === beat.from)
						text = this.theme.bg("selectedBg", text);
					rows.push({ text, beat });
				});
				if (extraAge)
					rows.push({ text: this.theme.fg("muted", `  ${age}`), beat });
				rows.push({ text: "" });
			}
		};
		section(
			"EARLIER",
			state.earlier
				? earlierBullets(state.earlier.bullets ?? state.earlier.text).map(
						(text, index) => ({
							...state.earlier!,
							text,
							at: index === 0 ? state.earlier!.at : undefined,
						}),
					)
				: [],
			true,
		);
		section("MILESTONES", state.chapters, true);
		section("RECENT", state.recent);
		if (!rows.length)
			rows.push({ text: this.theme.fg("muted", "No summary yet.") });
		this.rows = rows;
		return rows.map((row) => truncateToWidth(row.text, contentWidth, ""));
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const beat = this.rows[event.y]?.beat;
		if (event.type === "move") {
			if (this.hover !== beat?.from) {
				this.hover = beat?.from;
				this.actions.render();
			}
			return;
		}
		if (event.type === "click" && event.button === "left" && beat) {
			this.actions.jump(beat.from);
			return { handled: true };
		}
	}
}

export class MinimapView extends HStack {
	readonly scroll: ScrollView;
	readonly log: Log;
	private newActivity = false;
	private lastId = "";
	private button = { start: 0, end: 0, hover: false, active: false };

	constructor(
		readonly engine: MinimapEngine,
		private theme: Palette,
		private actions: ViewActions,
	) {
		super();
		this.log = new Log(engine, theme, actions);
		this.scroll = new ScrollView(this.log, {
			follow: "end",
			overscroll: "contain",
			scrollbar: "auto",
		});
		const header: Component = {
			invalidate() {},
			render: (width) => {
				const name = engine.state.model === "qwen" ? "Qwen ⇄" : "Luna · low ⇄";
				const label = `[ ${name} ]`;
				this.button.start = Math.max(8, width - visibleWidth(label));
				this.button.end = this.button.start + visibleWidth(label);
				let control = theme.fg("accent", label);
				if (this.button.active)
					control = theme.bg("selectedBg", theme.bold(control));
				else if (this.button.hover) control = theme.bg("selectedBg", control);
				return [
					truncateToWidth(
						theme.bold("MINIMAP") +
							" ".repeat(Math.max(1, this.button.start - 7)) +
							control,
						width,
						"",
					),
					...wrapTextWithAnsi(
						theme.fg("accent", "? ask") +
							"  " +
							theme.fg("customMessageLabel", "◆ decision") +
							"  " +
							theme.fg("success", "• change"),
						width,
					),
					...wrapTextWithAnsi(
						theme.fg("accent", "◇ check") +
							"  " +
							theme.fg("warning", "! issue") +
							"  " +
							theme.fg("success", "✓ done") +
							"  " +
							theme.fg("error", "× error"),
						width,
					),
					"",
				];
			},
			handleMouse: (event) => {
				const hit =
					event.y === 0 &&
					event.x >= this.button.start &&
					event.x < this.button.end;
				if (event.type === "press" && event.button === "left" && hit) {
					this.button.active = true;
					return { handled: true };
				}
				if (event.type === "release" && this.button.active) {
					this.button.active = false;
					return { handled: true };
				}
				if (event.type === "move" && hit !== this.button.hover) {
					this.button.hover = hit;
					actions.render();
				}
				if (hit && event.type === "click" && event.button === "left") {
					actions.switchModel();
					return { handled: true };
				}
			},
		};
		const pinned: Component = {
			invalidate() {},
			render: (width) => {
				const rows = [
					this.newActivity
						? theme.fg("accent", "↓ New activity · click to follow")
						: theme.fg("border", "─".repeat(width)),
					theme.bold(theme.fg("accent", "NOW")),
				];
				rows.push(...purposeRows(engine.state, width));
				rows.push(theme.fg("muted", actions.status()));
				if (engine.error) rows.push(theme.fg("warning", engine.error));
				else if (engine.catchingUp)
					rows.push(theme.fg("accent", "↻ Catching up…"));
				else if (engine.busy) rows.push(theme.fg("muted", "Updating summary…"));
				rows.push(
					...usageRows(engine.state.usage).map((row) => theme.fg("muted", row)),
				);
				return rows.map((row) => truncateToWidth(row, width, "…"));
			},
			handleMouse: (event) => {
				if (
					this.newActivity &&
					event.y === 0 &&
					event.type === "click" &&
					event.button === "left"
				) {
					this.scroll.scrollToEnd();
					this.newActivity = false;
					return { handled: true };
				}
			},
		};
		const panel = new VStack([
			header,
			{ component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			pinned,
		]);
		this.addChild(
			{
				render: () =>
					Array.from({ length: actions.rows() }, () => theme.fg("border", "│")),
				invalidate() {},
			},
			{ basis: 1, shrink: 0 },
		);
		this.addChild(panel, { basis: 0, grow: 1, minSize: 1 });
	}

	clearHover(): void {
		const changed =
			this.log.clearHover() || this.button.hover || this.button.active;
		this.button.hover = false;
		this.button.active = false;
		if (changed) this.actions.render();
	}

	refresh(): void {
		const top = this.scroll.scrollTop;
		const anchor = this.log.rows[top]?.beat;
		const following = this.scroll.isFollowingEnd;
		if (!following && this.lastId !== this.engine.state.lastId)
			this.newActivity = true;
		this.lastId = this.engine.state.lastId;
		const oldStart = anchor
			? this.log.rows.findIndex((row) => row.beat === anchor)
			: 0;
		this.log.render(this.log.width);
		this.scroll.updateLayout(
			this.log.rows.length,
			this.scroll.viewportHeight,
			this.actions.render,
		);
		if (!following && anchor) {
			const row = this.log.rows.findIndex(
				(row) => row.beat && this.actions.contains(row.beat, anchor.from),
			);
			if (row >= 0) {
				const same = this.log.rows[row]?.beat?.from === anchor.from;
				const count = this.log.rows
					.slice(row)
					.findIndex((item) => item.beat !== this.log.rows[row]!.beat);
				const offset = same
					? Math.min(top - oldStart, Math.max(0, count - 1))
					: 0;
				this.scroll.scrollTo(row + offset, { disableFollow: true });
			}
		}
		this.actions.render();
	}

	override handleMouse(
		event: TuiMouseEvent,
	): ReturnType<HStack["handleMouse"]> {
		// Wheel events over the pinned/header area must not scroll the main chat.
		if (event.type === "wheel") {
			this.scroll.scrollBy(event.wheelDelta ?? 0);
			if (this.scroll.isFollowingEnd) this.newActivity = false;
			return {
				handled: true,
				target: {
					component: this,
					originX: event.screenX - event.x,
					originY: event.screenY - event.y,
					width: event.width,
					height: event.height,
				},
			};
		}
	}
}
