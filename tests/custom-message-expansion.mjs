import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const modules = process.argv[2];
const load = (path) => import(pathToFileURL(`${modules}/${path}`));
const { CustomMessageComponent } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js");
const { initTheme } = await load("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
const { messageComponent } = await import(pathToFileURL(process.argv[3]));
initTheme("dark", false);
const details = { from: { id: "worker", name: "subagent-control" }, message: { content: { text: "Worker needs attention.\n" + "Context. ".repeat(40) + "END_OF_MESSAGE" } } };
const component = new CustomMessageComponent(
  { role: "custom", customType: "intercom_message", content: "notice", details, display: true, timestamp: Date.now() },
  (message, options, theme) => messageComponent(message.details, options, theme),
);
const shown = () => component.render(60).join("\n");
const click = () => component.handleMouse({ type: "click", button: "left", x: 2, y: 2, screenX: 2, screenY: 2, width: 60, height: component.render(60).length, shift: false, alt: false, ctrl: false });
assert(!shown().includes("END_OF_MESSAGE"));
assert(!shown().includes("ctrl+o"));
assert.equal(click()?.handled, true, "Native container must route clicks into the peer message");
assert(shown().includes("END_OF_MESSAGE"), "Click must expand native message state");
component.invalidate();
assert(shown().includes("END_OF_MESSAGE"), "Invalidation must retain click expansion");
click();
assert(!shown().includes("END_OF_MESSAGE"), "Second click must collapse");
component.setExpanded(true);
assert(shown().includes("END_OF_MESSAGE"), "Keyboard expansion must still work");
click();
assert(!shown().includes("END_OF_MESSAGE"), "Mouse and keyboard must share state");
component.setExpanded(true);
component.setExpanded(false);
assert(!shown().includes("END_OF_MESSAGE"));
console.log("Native peer-message click routing, redraw persistence and keyboard expansion passed");
