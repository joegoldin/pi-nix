// How a tool call is named in a prompt or the /permissions menu: the tool and
// the one argument that says what it acts on, as pi-custom's tool cards name
// a call, `Bash(git push --force)` or `Write(/etc/hosts)`. Pure.

const TARGET_KEYS = ["command", "path", "file_path", "pattern", "url", "query"];

function titleOf(toolName: string): string {
	return toolName.length ? toolName[0]!.toUpperCase() + toolName.slice(1) : toolName;
}

/** The call's title and target, the target on one line. */
export function callLabel(toolName: string, input: unknown): { title: string; target: string } {
	const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const key = TARGET_KEYS.find((k) => typeof args[k] === "string" && args[k] !== "");
	const raw = key ? String(args[key]) : JSON.stringify(args);
	const target = raw.replace(/\s*\n\s*/g, " ⏎ ").trim();
	return { title: titleOf(toolName), target: target === "{}" ? "" : target };
}

/** Canonical JSON: keys sorted at every level, so equal inputs compare equal as strings. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: v,
	);
}

/**
 * A block's reason without the wrapping meant for the model: which extension
 * spoke and what the agent should do next. What is left is what decided.
 */
export function shortReason(reason: string): string {
	let r = reason;
	const inner = /Reason: (\[pi-automode\][\s\S]*)$/.exec(r);
	if (inner) r = inner[1]!;
	r = r.replace(/^\[pi-automode\] Action blocked; the tool did not run\.\s*/, "");
	r = r.replace(/\s*Do not claim success[\s\S]*$/, "");
	r = r.replace(/^\[pi-permission-system\]\s*/, "");
	return r.trim();
}

/** Prefer the call's supplied purpose; never infer shell intent from a command name. */
export function callExplanation(toolName: string, input: unknown): string {
	const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
	if (typeof args.description === "string" && args.description.trim()) return args.description;
	switch (toolName) {
		case "bash": return "Run the shell command shown above; no purpose was supplied.";
		case "bg_run": return `Start a background shell task${typeof args.name === "string" ? `: ${args.name}` : "."}`;
		case "write": return "Create or overwrite the target file with the supplied content.";
		case "edit": return "Replace matching text in the target file.";
		case "read": return "Read the target file's contents.";
		default: return `Call ${toolName} with the supplied arguments; no explanation was supplied.`;
	}
}
