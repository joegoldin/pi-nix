// pi-custom's agent-tools part: what the model can do beyond pi's built-ins.
//
//   bg.ts    bg_run, bg_status, bg_logs, bg_kill; /jobs, /logs, /kill
//   todo.ts  the todo tool, its list above the editor, /todos
//   ask.ts   ask_user_question
//   goal.ts  /goal and goal_complete, goal_blocked, goal_wait
//   btw.ts   /btw side questions
//
// These replace pi-background-tasks, rpiv-todo, rpiv-ask-user-question,
// pi-goal and pi-btw, keeping the tool names, parameters and result text the
// model and recorded sessions know.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../ui/config.ts";
import { registerAsk } from "./ask.ts";
import { registerBackgroundTasks } from "./bg.ts";
import { registerBtw } from "./btw.ts";
import { registerGoal } from "./goal.ts";
import { registerTodo } from "./todo.ts";

export default function tools(pi: ExtensionAPI): void {
	registerBackgroundTasks(pi);
	registerTodo(pi);
	registerAsk(pi);
	// Read on use, so a limit changed in /ui applies to the running goal.
	registerGoal(pi, () => loadConfig());
	registerBtw(pi);
}
