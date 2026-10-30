import { matchesKey, stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { layoutCard, type CardModel, type UiTheme } from "../ui/card.ts";
import { Framed } from "../ui/frame.ts";
import type { TaskSnapshot, TaskStatus } from "./bg-format.ts";

const icons: Record<TaskStatus, string> = { running: "\uf110", completed: "\uf00c", failed: "\uf00d", killed: "\uf04d" };
const colours: Record<TaskStatus, string> = { running: "accent", completed: "success", failed: "error", killed: "warning" };
const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

export function taskLabel(task: TaskSnapshot, theme: UiTheme): string {
	return theme.fg(colours[task.status], `${icons[task.status]} ${task.status}`) + ` ${clean(task.name).replace(/\s+/g, " ")} ` + theme.fg("dim", task.id);
}

export function taskRows(tasks: TaskSnapshot[], theme: UiTheme): string[] {
	return tasks.length ? tasks.flatMap(task => [
		taskLabel(task, theme),
		theme.fg("dim", `  $ ${clean(task.command)}`),
		theme.fg("dim", `  ${clean(task.outputPath)}`),
		...(task.error ? [theme.fg("error", `  ${clean(task.error)}`)] : []),
		"",
	]) : [theme.fg("muted", "No background tasks yet")];
}

export function taskNotification(task: TaskSnapshot, theme: UiTheme, expanded: boolean) {
	const model: CardModel = {
		title: "Background", target: clean(task.name).replace(/\s+/g, " "),
		state: task.status === "failed" ? "error" : task.status === "running" ? "pending" : "success",
		summary: taskLabel(task, theme),
		body: [theme.fg("dim", `Output: ${clean(task.outputPath)}`), ...(task.error ? [theme.fg("error", clean(task.error))] : [])],
	};
	return { render: (width: number) => layoutCard(model, { mode: "on", expanded, collapsedLines: 3, expandedLines: 100, expandHint: "(ctrl+o)" }, theme, width), invalidate() {} };
}

/** The same framed, keyboard-driven surface as /context and /ui. */
export function taskPanel(title: string, rows: () => string[], theme: UiTheme, height: () => number, repaint: () => void, close: () => void): Framed {
	let top = 0;
	let max = 0;
	let page = 1;
	return new Framed({
		render(width) {
			const lines = rows().flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
			page = Math.max(1, height() - 6);
			max = Math.max(0, lines.length - page);
			top = Math.min(top, max);
			return [...lines.slice(top, top + page), theme.fg("dim", `↑↓ PgUp/PgDn · ${top + 1}–${Math.min(lines.length, top + page)}/${lines.length} · Esc close`)];
		},
		handleInput(data) {
			if (matchesKey(data, "escape") || matchesKey(data, "enter")) return close();
			if (matchesKey(data, "up")) top = Math.max(0, top - 1);
			else if (matchesKey(data, "down")) top = Math.min(max, top + 1);
			else if (matchesKey(data, "pageUp")) top = Math.max(0, top - page);
			else if (matchesKey(data, "pageDown")) top = Math.min(max, top + page);
			else if (matchesKey(data, "home")) top = 0;
			else if (matchesKey(data, "end")) top = max;
			repaint();
		},
		invalidate() {},
	}, title, theme);
}
