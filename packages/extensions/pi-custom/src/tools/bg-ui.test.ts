import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { taskNotification, taskPanel, taskRows } from "./bg-ui.ts";
import { buildCard } from "../ui/tools.ts";
import { DEFAULTS } from "../ui/config.ts";
import type { TaskSnapshot } from "./bg-format.ts";
const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s };
const task: TaskSnapshot = { id: "b123", name: "Run tests", command: "bun test", status: "failed", error: "assertion failed", startTime: 0, endTime: 1000, outputPath: ".pi/tasks/test.log" };

test("notifications use bounded custom cards and preserve failure details", () => {
  const card = taskNotification(task, theme, true);
  for (const width of [12, 40, 80]) {
    const rows = card.render(width);
    expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
    expect(rows.join("\n")).toContain("Background");
  }
  expect(card.render(80).join("\n")).toContain("assertion failed");
});

test("background tools show human names and summaries rather than argument dumps", () => {
  for (const toolName of ["bg_run", "bg_status", "bg_logs", "bg_kill"]) {
    const card = buildCard({ toolName, args: {}, cwd: "/tmp", isPartial: false, isError: false, result: { details: { task }, content: [{ type: "text", text: "output" }] } }, { theme, config: DEFAULTS, highlight: s => [s], languageOf: () => undefined });
    expect(card.target).toBe("Run tests");
    expect(card.summary).toContain("failed");
  }
});

test("job and log panels are framed, scrollable, resize-safe and dismissible", () => {
  let closed = false;
  let height = 12;
  const panel = taskPanel("Background tasks", () => Array.from({ length: 40 }, (_, i) => `line ${i}`), theme, () => height, () => {}, () => { closed = true; });
  const first = panel.render(40);
  expect(first[0]).toContain("╭");
  expect(first.at(-1)).toContain("╯");
  expect(first.every(row => visibleWidth(row) === 40)).toBe(true);
  panel.handleInput("\x1b[F");
  expect(panel.render(40).join("\n")).toContain("line 39");
  height = 8;
  expect(panel.render(40).length).toBeLessThanOrEqual(8);
  panel.handleInput("\x1b[H");
  expect(panel.render(40).join("\n")).toContain("line 0");
  panel.handleInput("\x1b");
  expect(closed).toBe(true);
  expect(stripTerminalSequences(taskRows([task], theme).join("\n"))).toContain("assertion failed");
});
