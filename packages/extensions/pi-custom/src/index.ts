// pi-custom: the one first-party extension for this setup's own pi features.
//
// Four parts, each registering against the same pi:
//
//   ui/      how the session looks: Claude Code-style tool cards, markdown
//            touches, the prompt box, /ui, /context, @ references, and
//            find/grep through FFF.
//   extras/  prompt and session handling: the prompt stash, ctrl+s chords,
//            and the session commands.
//   tools/   what the model can do beyond pi's built-ins: background shell
//            tasks, a todo list, structured questions, /goal and /btw.
//   intercom/ messaging with other pi and Claude Code sessions on the machine.
//
// They were separate extensions once. Kept as directories rather than merged
// into one file because they share nothing but pi itself.

import extras from "./extras/index.ts";
import intercom from "./intercom/index.ts";
import tools from "./tools/index.ts";
import ui from "./ui/index.ts";

export default function piCustom(pi: Parameters<typeof ui>[0]): void {
	ui(pi);
	extras(pi as never);
	tools(pi);
	intercom(pi);
}
