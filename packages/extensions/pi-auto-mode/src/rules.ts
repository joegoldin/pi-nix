// Deterministic permission matching. Design §9 layer 2, implemented inside
// pi-auto-mode so assumption A2's fallback is the shipped state rather than a
// rewrite. Task 6 delegates this to @gotgenes/pi-permission-system without
// deleting it — the built-in path stays the fallback when that package is
// absent.
//
// Rule syntax deliberately mirrors Claude Code's permissions entries so one
// declaration in programs.agent-skills can feed both agents.

export type PermissionState = "allow" | "deny" | "ask";

export interface ParsedRule {
	raw: string;
	/** pi tool name, lowercased and de-aliased. */
	tool: string;
	/** null means the rule covers every call to the tool. */
	matcher: string | null;
}

/** Claude Code tool names on the left, pi's on the right. */
const TOOL_ALIASES: Record<string, string> = {
	bash: "bash",
	shell: "bash",
	read: "read",
	write: "write",
	edit: "edit",
	multiedit: "edit",
	grep: "grep",
	glob: "find",
	find: "find",
	ls: "ls",
	list: "ls",
};

function normalizeTool(name: string): string | null {
	const key = name.trim().toLowerCase();
	if (key === "") return null;
	return TOOL_ALIASES[key] ?? key;
}

export function parseRule(raw: string): ParsedRule | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;

	const open = trimmed.indexOf("(");
	if (open === -1) {
		const tool = normalizeTool(trimmed);
		return tool === null ? null : { raw: trimmed, tool, matcher: null };
	}
	if (!trimmed.endsWith(")")) return null;

	const tool = normalizeTool(trimmed.slice(0, open));
	if (tool === null) return null;
	return { raw: trimmed, tool, matcher: trimmed.slice(open + 1, -1) };
}

const REGEX_META = /[.+^${}()|[\]\\]/g;

export function globToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else {
			out += c.replace(REGEX_META, "\\$&");
		}
	}
	return new RegExp(`^${out}$`);
}

export function matchesMatcher(matcher: string, value: string): boolean {
	if (matcher === "" || matcher === "*") return true;
	if (matcher.endsWith(":*")) {
		const prefix = matcher.slice(0, -2);
		return value === prefix || value.startsWith(`${prefix} `);
	}
	if (matcher.includes("*") || matcher.includes("?")) return globToRegExp(matcher).test(value);
	return value === matcher;
}

// Prefix rules are only safe on a single command. `git status && rm -rf /`
// starts with `git status `, so without this guard `Bash(git status:*)` would
// allow it. The built-in matcher has no shell parser (that is exactly what
// pi-permission-system's tree-sitter-bash buys us in Task 6), so it refuses to
// *allow* anything containing a control operator and defers to the classifier.
// Deny rules still apply — refusing to deny would be the unsafe direction.
const SHELL_CONTROL = /(\|\||&&|\$\(|`|[;|&\n]|<\(|>\()/;

export function hasShellControl(value: string): boolean {
	return SHELL_CONTROL.test(value);
}

export interface DeterministicRules {
	allow: string[];
	deny: string[];
}

export interface RuleTarget {
	toolName: string;
	value: string;
}

export interface DeterministicDecision {
	state: PermissionState;
	matchedRule?: string;
}

function firstMatch(raws: readonly string[], target: RuleTarget): string | undefined {
	const tool = target.toolName.toLowerCase();
	for (const raw of raws) {
		const rule = parseRule(raw);
		if (rule === null) continue;
		if (rule.tool !== tool) continue;
		if (rule.matcher === null) return rule.raw;
		if (matchesMatcher(rule.matcher, target.value)) return rule.raw;
	}
	return undefined;
}

export function evaluateDeterministic(rules: DeterministicRules, target: RuleTarget): DeterministicDecision {
	const denied = firstMatch(rules.deny ?? [], target);
	if (denied !== undefined) return { state: "deny", matchedRule: denied };

	const unparsedShell = target.toolName.toLowerCase() === "bash" && hasShellControl(target.value);
	if (unparsedShell) return { state: "ask" };

	const allowed = firstMatch(rules.allow ?? [], target);
	if (allowed !== undefined) return { state: "allow", matchedRule: allowed };

	return { state: "ask" };
}
