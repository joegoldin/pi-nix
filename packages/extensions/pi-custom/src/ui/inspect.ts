// Which shell commands only look: the bash calls a run may fold away.
//
// A run hides its calls behind one line, so only calls nobody needs to see
// may join it. A command qualifies when every program it runs is on a list of
// inspection commands, used in a way that does not write: `git log` but not
// `git commit`, `sed -n` but not `sed -i`, `find` without `-delete`. Anything
// this cannot read with confidence, from an unknown program to a command
// substitution, counts as doing something, and the call keeps its card.
//
// Pure: a command string in, a yes or no out.

/** A program's words, quotes removed: the program first, its arguments after. */
type Words = string[];

/** Each program's own test of its arguments. */
type Check = (args: Words) => boolean;

const always: Check = () => true;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Redirection targets that write nowhere. */
const SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/**
 * Split a command into its programs' words, or undefined when it holds
 * something that could run or write anything: a command substitution, a
 * subshell, a redirection into a file.
 */
export function splitCommand(command: string): Words[] | undefined {
	const segments: Words[] = [];
	let words: Words = [];
	let word = "";
	// A word can be empty yet present: "" is an argument.
	let inWord = false;
	let i = 0;
	const s = command;

	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};

	/** Read one word from i, honouring quotes; undefined on what this does not follow. */
	const readWord = (): string | undefined => {
		let out = "";
		while (i < s.length) {
			const c = s[i];
			if (c === " " || c === "\t" || c === "\n" || ";&|<>()".includes(c)) break;
			const piece = readPiece();
			if (piece === undefined) return undefined;
			out += piece;
		}
		return out;
	};

	/** One quoted string, escape or plain character at i. */
	const readPiece = (): string | undefined => {
		const c = s[i];
		if (c === "`") return undefined;
		if (c === "$" && s[i + 1] === "(") return undefined;
		if (c === "\\") {
			i += 2;
			// A backslash before a newline continues the line.
			return s[i - 1] === "\n" ? "" : (s[i - 1] ?? "");
		}
		if (c === "'") {
			const end = s.indexOf("'", i + 1);
			if (end < 0) return undefined;
			const text = s.slice(i + 1, end);
			i = end + 1;
			return text;
		}
		if (c === '"') {
			let text = "";
			i++;
			while (i < s.length && s[i] !== '"') {
				if (s[i] === "`" || (s[i] === "$" && s[i + 1] === "(")) return undefined;
				if (s[i] === "\\" && i + 1 < s.length) i++;
				text += s[i++];
			}
			if (i >= s.length) return undefined;
			i++;
			return text;
		}
		i++;
		return c;
	};

	while (i < s.length) {
		const c = s[i];
		if (c === " " || c === "\t") {
			endWord();
			i++;
		} else if (c === "\\" && s[i + 1] === "\n") {
			// A continued line: the shell drops both characters.
			i += 2;
		} else if (c === "\n" || c === ";") {
			endSegment();
			i++;
		} else if (c === "#" && !inWord) {
			while (i < s.length && s[i] !== "\n") i++;
		} else if (c === "(" || c === ")") {
			return undefined;
		} else if (c === "|") {
			endSegment();
			i += s[i + 1] === "|" || s[i + 1] === "&" ? 2 : 1;
		} else if (c === "&" && s[i + 1] === "&") {
			endSegment();
			i += 2;
		} else if (c === ">" || c === "<" || (c === "&" && s[i + 1] === ">")) {
			// The digits before a redirection are its file descriptor, not a word.
			if (inWord && /^\d+$/.test(word)) {
				word = "";
				inWord = false;
			}
			endWord();
			if (!readRedirection()) return undefined;
		} else if (c === "&") {
			endSegment();
			i++;
		} else {
			const piece = readPiece();
			if (piece === undefined) return undefined;
			word += piece;
			inWord = true;
		}
	}
	endSegment();
	return segments;

	/** A redirection at i: reading is fine, writing only into a sink. */
	function readRedirection(): boolean {
		let op = s[i++];
		while (i < s.length && "<>&|".includes(s[i]) && op.length < 3) op += s[i++];
		if (s[i] === "(") return false;
		while (s[i] === " " || s[i] === "\t") i++;
		const target = readWord();
		if (target === undefined) return false;
		// Duplicating or closing a descriptor (2>&1, >&2, <&-) opens no file.
		if (op === ">&" || op === "<&") return /^(\d+|-)$/.test(target) || SINKS.has(target);
		if (op === "<" || op === "<<" || op === "<<<") return true;
		// >, >>, >|, &>, &>> and <>, which opens for writing too.
		return op !== "<>" && SINKS.has(target);
	}
}

/** The arguments that are options, and the rest. */
function positionals(args: Words): Words {
	return args.filter((a) => !a.startsWith("-"));
}

/**
 * The letters of a short option cluster: "ni" for -ni, "i" for -i.bak. Each
 * is an option of its own, so -ni is as in-place as -i.
 */
function shortFlags(arg: string): string {
	return /^-([A-Za-z]+)/.exec(arg)?.[1] ?? "";
}

/**
 * Skip a tool's global options to reach its subcommand: flags, and the
 * options named in `valued` together with the value after each.
 */
function subcommand(args: Words, valued: ReadonlySet<string> = new Set()): Words {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		i += valued.has(args[i]) ? 2 : 1;
	}
	return args.slice(i);
}

const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GIT_READS = new Set(["status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "describe", "grep"]);

function gitReads(args: Words): boolean {
	const [sub, ...rest] = subcommand(args, GIT_VALUED);
	if (rest.some((a) => a === "--output" || a.startsWith("--output="))) return false;
	if (GIT_READS.has(sub)) return true;
	// Listing branches reads; naming one creates, moves or deletes it.
	if (sub === "branch") {
		return rest.every((a) => a.startsWith("-") && !/^-[dDmMcCfu]$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(a));
	}
	if (sub === "remote") {
		const [verb] = positionals(rest);
		return verb === undefined || verb === "show" || verb === "get-url";
	}
	return false;
}

const JJ_VALUED = new Set(["-R", "--repository", "--at-op", "--at-operation", "--color", "--config", "--config-file", "--config-toml"]);

function jjReads(args: Words): boolean {
	const [sub, verb] = subcommand(args, JJ_VALUED);
	switch (sub) {
		case "st":
		case "status":
		case "log":
		case "diff":
		case "show":
		case "evolog":
		case "obslog":
			return true;
		case "op":
		case "operation":
			return verb === "log";
		case "bookmark":
		case "b":
			return verb === "list" || verb === "l";
		case "file":
			return verb === "show" || verb === "list";
		default:
			return false;
	}
}

function nixReads(args: Words): boolean {
	let i = 0;
	// nix takes its global options before the subcommand too; --option has two values.
	while (i < args.length && args[i].startsWith("-")) {
		i += args[i] === "--option" ? 3 : args[i].endsWith("experimental-features") ? 2 : 1;
	}
	const [sub, verb] = args.slice(i);
	if (args.some((a) => a === "--write-to" || a.startsWith("--write-to="))) return false;
	if (sub === "flake") return verb === "show" || verb === "metadata";
	return sub === "eval" || sub === "path-info" || sub === "why-depends" || sub === "log";
}

const GH_READS: Record<string, ReadonlySet<string>> = {
	pr: new Set(["view", "list", "checks"]),
	issue: new Set(["view", "list"]),
	run: new Set(["view", "list"]),
};

function ghReads(args: Words): boolean {
	const [sub, verb] = args;
	if (sub === "api") return ghApiGets(args.slice(1));
	return GH_READS[sub]?.has(verb) ?? false;
}

/** gh api sends a GET unless told a method or given fields, which make it a POST. */
function ghApiGets(args: Words): boolean {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		let method: string | undefined;
		if (a === "-X" || a === "--method") method = args[++i];
		else if (a.startsWith("--method=")) method = a.slice("--method=".length);
		else if (a.startsWith("-X")) method = a.slice(2);
		if (method !== undefined && method.toUpperCase() !== "GET") return false;
		if (/^(-f|-F|--field|--raw-field|--input)($|=)/.test(a) || /^-[fF]./.test(a)) return false;
	}
	return true;
}

const KUBECTL_VALUED = new Set(["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server", "--as"]);

const CHECKS: Record<string, Check> = {
	ls: always,
	cat: always,
	head: always,
	tail: always,
	less: always,
	wc: always,
	file: always,
	stat: always,
	du: always,
	df: always,
	tree: (args) => !args.some((a) => a.startsWith("-o")),
	pwd: always,
	which: always,
	type: always,
	echo: always,
	printf: always,
	grep: always,
	rg: (args) => !args.some((a) => a === "--pre" || a.startsWith("--pre=")),
	ag: always,
	fd: (args) => !args.some((a) => a === "--exec" || a === "--exec-batch" || /[xX]/.test(shortFlags(a))),
	find: (args) => !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a)),
	jq: always,
	yq: (args) => !args.some((a) => a.startsWith("--inplace") || shortFlags(a).includes("i")),
	sed: (args) =>
		!args.some((a) => a.startsWith("--in-place") || shortFlags(a).includes("i")) &&
		args.some((a) => a === "--quiet" || a === "--silent" || shortFlags(a).includes("n")),
	// A redirection, a pipe or system() inside the program writes or runs something.
	awk: (args) => !args.some((a) => /[>|]|system/.test(a) || a === "-i"),
	sort: (args) => !args.some((a) => a.startsWith("--output") || shortFlags(a).includes("o")),
	// A second file operand is where uniq writes.
	uniq: (args) => positionals(args).length <= 1,
	cut: always,
	tr: always,
	column: always,
	diff: always,
	cmp: always,
	git: gitReads,
	jj: jjReads,
	nix: nixReads,
	gh: ghReads,
	kubectl: (args) => ["get", "describe", "logs"].includes(subcommand(args, KUBECTL_VALUED)[0]),
	systemctl: (args) => subcommand(args)[0] === "status",
	journalctl: (args) =>
		!args.some((a) => /^--(vacuum|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)/.test(a)),
	ps: always,
	// env runs whatever follows its assignments, which has to pass on its own.
	env: envReads,
	// date sets the clock with -s, or with a bare string of digits on BSD.
	date: (args) => !args.some((a) => a === "-s" || a.startsWith("--set") || /^\d+(\.\d+)?$/.test(a)),
	uname: always,
	// Changes nothing but the directory the rest runs in: `cd dir && ls`.
	cd: always,
	// Does nothing, which is what `grep x || true` asks of it.
	true: always,
};

function envReads(args: Words): boolean {
	let i = 0;
	while (i < args.length && (args[i].startsWith("-") || ASSIGNMENT.test(args[i]))) {
		// -S splits a string into a command line this does not read.
		if (args[i] === "-S" || args[i].startsWith("--split-string")) return false;
		i += args[i] === "-u" || args[i] === "-C" ? 2 : 1;
	}
	return i >= args.length || segmentReads(args.slice(i));
}

function segmentReads(words: Words): boolean {
	const start = words.findIndex((w) => !ASSIGNMENT.test(w));
	// Assignments alone set shell variables and run nothing.
	if (start < 0) return true;
	const [program, ...args] = words.slice(start);
	const check = Object.hasOwn(CHECKS, program) ? CHECKS[program] : undefined;
	return check !== undefined && check(args);
}

/** Whether a shell command only inspects: every program in it is a known reader, used to read. */
export function isInspection(command: string): boolean {
	const segments = splitCommand(command);
	if (!segments || segments.length === 0) return false;
	return segments.every(segmentReads);
}
