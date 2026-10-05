// File and directory glyphs for ls, find and grep cards.
//
// Nerd Font code points, keyed by extension and by a few names that mean more
// than their extension (a Dockerfile has none). With nerdIcons off every entry
// collapses to nothing rather than to a placeholder, so plain terminals get
// plain paths instead of tofu.

const DIR = "\uf07b"; // nf-fa-folder
const FILE = "\uf15b"; // nf-fa-file

const IMAGE = "\uf1c5";
const ARCHIVE = "\uf1c6";
const SHELL = "\uf489";
const CONFIG = "\ue615";

const BY_NAME: Record<string, string> = {
	dockerfile: "\uf308",
	makefile: "\uf085",
	justfile: "\uf085",
	"flake.nix": "\uf313",
	"flake.lock": "\uf023",
	"package.json": "\ue71e",
	"cargo.toml": "\ue7a8",
	"go.mod": "\ue627",
	license: "\uf0a3",
	".gitignore": "\ue702",
};

const BY_EXT: Record<string, string> = {
	ts: "\ue628",
	tsx: "\ue7ba",
	js: "\ue74e",
	jsx: "\ue7ba",
	mjs: "\ue74e",
	json: "\ue60b",
	md: "\uf48a",
	nix: "\uf313",
	py: "\ue73c",
	rs: "\ue7a8",
	go: "\ue627",
	rb: "\ue739",
	sh: SHELL,
	bash: SHELL,
	zsh: SHELL,
	fish: SHELL,
	lua: "\ue620",
	c: "\ue61e",
	h: "\ue61e",
	cpp: "\ue61d",
	hpp: "\ue61d",
	java: "\ue738",
	kt: "\ue634",
	swift: "\ue755",
	html: "\ue736",
	css: "\ue749",
	scss: "\ue603",
	yaml: CONFIG,
	yml: CONFIG,
	toml: CONFIG,
	sql: "\ue706",
	lock: "\uf023",
	png: IMAGE,
	jpg: IMAGE,
	jpeg: IMAGE,
	gif: IMAGE,
	svg: IMAGE,
	pdf: "\uf1c1",
	zip: ARCHIVE,
	gz: ARCHIVE,
	txt: "\uf15c",
};

/** The glyph for a path, followed by a space, or "" when icons are off. */
export function iconFor(path: string, isDir: boolean, enabled: boolean): string {
	if (!enabled) return "";
	if (isDir) return `${DIR} `;
	const base = path.split("/").pop()?.toLowerCase() ?? "";
	const named = BY_NAME[base];
	if (named) return `${named} `;
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 ? base.slice(dot + 1) : "";
	return `${BY_EXT[ext] ?? FILE} `;
}
