import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { readCalls } from "./audit.ts";
import { clean, STATE_TYPE } from "./state.ts";

export async function showHistory(ctx: ExtensionContext): Promise<void> {
	const entries = ctx.sessionManager.getEntries();
	const calls = readCalls(entries);
	const snapshots = entries.filter(
		(entry) => entry.type === "custom" && entry.customType === STATE_TYPE,
	);
	if (!calls.length && !snapshots.length) {
		ctx.ui.notify("No minimap history recorded yet", "info");
		return;
	}
	const snapshotLabel = "Saved sidebar snapshots (including older versions)";
	const labels = calls.map((call, index) => {
		const first = call.events[0]!;
		const model =
			typeof first.model === "string"
				? clean(first.model, 64)
				: call.id.slice(0, 8);
		return `${index + 1}. ${new Date(first.at).toISOString()} ${model} · ${call.events.at(-1)!.phase}${call.sessionId !== ctx.sessionManager.getSessionId() ? " (inherited)" : ""}`;
	});
	const selected = await ctx.ui.select(
		"Minimap history · no new inference",
		[...labels].reverse().concat(snapshots.length ? [snapshotLabel] : []),
	);
	if (!selected) return;
	let title = selected;
	let value: unknown;
	if (selected === snapshotLabel) {
		const options = snapshots.map(
			(entry, index) => `${index + 1}. ${entry.timestamp}`,
		);
		const chosen = await ctx.ui.select(
			"Saved sidebar snapshots",
			[...options].reverse(),
		);
		if (!chosen) return;
		title = `Minimap snapshot · ${chosen}`;
		value = snapshots[options.indexOf(chosen)];
	} else {
		const call = calls[labels.indexOf(selected)]!;
		value = {
			...call,
			displayedSnapshots: call.events
				.filter((event) => event.phase === "applied" && event.stateEntryId)
				.map((event) =>
					entries.find((entry) => entry.id === event.stateEntryId),
				),
		};
	}
	// JSON escaping makes even hostile terminal-control bytes inert. Nothing is
	// clipped: scrolling this viewer never changes the model's bounded context.
	const body = JSON.stringify(value, null, 2);
	await ctx.ui.custom<void>(
		(tui, theme, _keys, done) => {
			const text = new Text(body, 0, 0);
			let offset = 0,
				total = 0,
				height = 1;
			return {
				render(width) {
					height = Math.max(1, Math.floor(tui.terminal.rows * 0.85) - 2);
					const lines = text.render(width);
					total = lines.length;
					offset = Math.max(0, Math.min(offset, total - height));
					return [
						theme.fg("accent", truncateToWidth(title, width)),
						...lines.slice(offset, offset + height),
						theme.fg(
							"muted",
							truncateToWidth("↑↓ PgUp/PgDn Home/End · Esc/Enter close", width),
						),
					];
				},
				invalidate() {
					text.invalidate();
				},
				handleInput(data) {
					if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
						done();
						return;
					}
					if (matchesKey(data, "up")) offset--;
					else if (matchesKey(data, "down")) offset++;
					else if (matchesKey(data, "pageUp")) offset -= height;
					else if (matchesKey(data, "pageDown")) offset += height;
					else if (matchesKey(data, "home")) offset = 0;
					else if (matchesKey(data, "end")) offset = total;
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" },
		},
	);
}
