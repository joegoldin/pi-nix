// pi-permissions: permissions and auto mode for pi in one extension.
//
// Two engines, vendored (see ATTRIBUTION.md): engine/ is pi-permission-system,
// the policy rules, gates, authorizer chain, prompt, session grants and
// subagent forwarding; auto/ is pi-automode, the classifier and the
// deterministic checks in front of it. Auto mode joins the permission system's
// authorizer chain as a link (auto/permission-chain.ts), as it did when the two
// were separate packages, so an ask the rules raise goes to the classifier
// before it reaches you.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoMode from "./auto/index.ts";
import permissionSystem from "./engine/index.ts";

// Asked on the session's event bus before registering. A subagent can be
// handed this package twice, by path: pi-subagents passes its npm link, and
// settings.json's packages list passes the store path. pi de-duplicates by the
// path as written, so both would load and the second would fail on a tool name
// the first registered. The bus is the session's own, and runs a handler
// synchronously up to its first await, so the copy that loaded first answers
// before the second registers anything.
const PROBE = "pi-permissions:loaded";

export default function piPermissions(pi: ExtensionAPI): void {
	const probe = { loaded: false };
	pi.events.emit(PROBE, probe);
	if (probe.loaded) return;
	pi.events.on(PROBE, (data) => {
		(data as { loaded: boolean }).loaded = true;
	});

	// In the order the two packages were loaded: auto mode's tool_call handler
	// runs first, so its deterministic denials stop a call before the
	// permission system prompts for it.
	autoMode(pi);
	permissionSystem(pi);
}
