// pi-custom's agent-tools part: what the model can do beyond pi's built-ins.
//
//   bg.ts    bg_run, bg_status, bg_logs, bg_kill; /jobs, /logs, /kill
//   ask.ts   ask_user_question
//   goal.ts  /goal and goal_complete, goal_blocked, goal_wait
//   btw.ts   /btw side questions
//   turn.ts  the summary line after a run: how long, done when, shells left
//
// These replace pi-background-tasks, rpiv-ask-user-question,
// pi-goal and pi-btw, keeping the tool names, parameters and result text the
// model and recorded sessions know.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../ui/config.ts";
import { registerAsk } from "./ask.ts";
import { registerBackgroundTasks } from "./bg.ts";
import { registerBtw } from "./btw.ts";
import { registerGoal } from "./goal.ts";
import { registerRunSummary } from "./turn.ts";

export default function tools(pi: ExtensionAPI): { exitBlockers(): string[] } {
	const shells = registerBackgroundTasks(pi);
	pi.on("context_with_system", (event) => {
		// Resuming a pre-checklist session must not revive its pruning reminders.
		const messages = event.messages.filter(message =>
			message.role !== "custom" || message.customType !== "pi-custom:todo-maintenance");
		if (messages.length !== event.messages.length) return { messages };
	});
	registerAsk(pi);
	// Read on use, so a limit changed in /ui applies to the running goal.
	const goal = registerGoal(pi, () => loadConfig());
	const sides = registerBtw(pi);
	registerRunSummary(pi, () => loadConfig(), shells.running);
	return { exitBlockers: () => [
		...(shells.running() ? ["Background tasks are still running"] : []),
		...(sides.running() ? ["/btw turns are still running"] : []),
		...(goal.active() ? ["An active /goal needs to be completed or stopped"] : []),
	] };
}
