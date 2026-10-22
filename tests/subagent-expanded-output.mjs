import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const { steeringReceipt, steeringMessagePreview, STEERING_MESSAGE_PREVIEW_LIMIT } = await import(pathToFileURL(join(root, "src/runs/background/steering.js")));
const { renderSubagentResult } = await import(pathToFileURL(join(root, "src/tui/render.js")));
const theme = { fg: (_color, text) => text, bold: (text) => text };
const message = "Preserve terminal identity and validate cancelled drops. ".repeat(15) + "FINAL_ACCEPTANCE_MARKER\nSecond paragraph\n```embedded fence```";
const receipt = steeringReceipt(message, "Steering queued for async run test.");
assert(receipt.includes(message), "Full receipt lost part of the submitted message");
assert(steeringMessagePreview(message).length <= STEERING_MESSAGE_PREVIEW_LIMIT, "Status previews must remain bounded");
assert(receipt.includes("````text"), "The receipt must safely enclose embedded fences");
const result = { content: [{ type: "text", text: receipt }], details: { mode: "management", results: [] } };
for (const width of [40, 80, 140]) {
  const expanded = renderSubagentResult(result, { expanded: true }, theme).render(width);
  assert(expanded.join("\n").includes("FINAL_ACCEPTANCE_MARKER"), `Expanded receipt clipped at width ${width}`);
  assert(expanded.every((line) => line.length <= width), "Expanded rows must fit the viewport");
  const collapsed = renderSubagentResult(result, { expanded: false }, theme).render(width);
  assert(!collapsed.join("\n").includes("FINAL_ACCEPTANCE_MARKER"), "Collapsed output should stay compact");
}
const single = { content: [{ type: "text", text: "long response ".repeat(40) + "SINGLE_LINE_END" }], details: { mode: "management", results: [] } };
assert(renderSubagentResult(single, { expanded: true }, theme).render(80).join("\n").includes("SINGLE_LINE_END"), "Expanded single-line output was truncated");
const sensitive = steeringReceipt("before Bearer synthetic-test-token\nafter\u001b[31mRED\u001b[0m\u202E text", "queued");
assert(!sensitive.includes("synthetic-test-token"), "Secret redaction was lost");
assert(!sensitive.includes("\u001b") && !sensitive.includes("\u202E"), "Unsafe terminal controls were emitted");
assert(sensitive.includes("after"), "Safety handling discarded ordinary text");
console.log("Full expanded receipts, single-line wrapping, compact previews, fences and terminal safety passed");
