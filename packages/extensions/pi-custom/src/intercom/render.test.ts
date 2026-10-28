import { expect, it } from "bun:test";
import { type InboundDetails, messageComponent, messageLines } from "./render.ts";

const details = {
	from: { id: "worker", name: "subagent-control" },
	message: { content: { text: "Worker needs attention.\n" + "More context. ".repeat(30) + "END_OF_MESSAGE" } },
} as InboundDetails;
const theme = { fg: (_slot: string, text: string) => text };

it("keeps collapsed peer messages compact without repeated expansion instructions", () => {
	const lines = messageLines(details, 60, true, theme);
	expect(lines).toHaveLength(3);
	expect(lines.join("\n")).not.toContain("ctrl+o");
	expect(lines.join("\n")).not.toContain("END_OF_MESSAGE");
	expect(messageLines(details, 60, false, theme).join("\n")).toContain("END_OF_MESSAGE");
	expect(messageLines({ ...details, replyCommand: "intercom reply" }, 60, true, theme).join("\n")).toContain("To reply: intercom reply");
});

it("delegates primary clicks to native expansion without swallowing scrolling or other buttons", () => {
	let toggles = 0;
	const component = messageComponent(details, { expanded: false, toggleExpanded: () => toggles++ }, theme);
	const click = { type: "click", button: "left", x: 1, y: 1, screenX: 1, screenY: 1, width: 60, height: 3, shift: false, alt: false, ctrl: false } as const;
	expect(component.handleMouse?.(click)).toEqual({ handled: true });
	expect(toggles).toBe(1);
	expect(component.handleMouse?.({ ...click, button: "right" })).toBeUndefined();
	expect(component.handleMouse?.({ ...click, type: "wheel", button: "none", wheelDelta: 1 })).toBeUndefined();
	expect(toggles).toBe(1);
	expect(messageComponent(details, { expanded: false }, theme).handleMouse?.(click)).toBeUndefined();
});
