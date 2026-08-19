import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverForeignSkillDirs } from "./discover.ts";
import { registerHandlers } from "./index.ts";

function tmpTree(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreign-skills-"));
}

describe("discoverForeignSkillDirs", () => {
	test("returns the absolute .claude/skills directory when it exists", () => {
		const root = tmpTree();
		fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
		expect(discoverForeignSkillDirs(root)).toEqual([path.join(root, ".claude", "skills")]);
	});

	test("returns nothing when .claude exists without skills", () => {
		const root = tmpTree();
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		expect(discoverForeignSkillDirs(root)).toEqual([]);
	});

	test("returns nothing at all when there is no .claude", () => {
		expect(discoverForeignSkillDirs(tmpTree())).toEqual([]);
	});

	// pi's own diagnostics treat an unreadable resource path as a warning, so a
	// file where a directory belongs must not be forwarded.
	test("ignores a .claude/skills that is a file", () => {
		const root = tmpTree();
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(root, ".claude", "skills"), "not a directory");
		expect(discoverForeignSkillDirs(root)).toEqual([]);
	});

	// The ancestor walk pi does for .agents/skills is deliberately not copied:
	// a nested checkout must not inherit its parent repository's skills.
	test("does not walk up to a parent directory", () => {
		const root = tmpTree();
		fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
		const nested = path.join(root, "nested");
		fs.mkdirSync(nested);
		expect(discoverForeignSkillDirs(nested)).toEqual([]);
	});
});

describe("registerHandlers", () => {
	function fakePi() {
		const handlers = new Map<string, (e: unknown) => unknown>();
		return {
			pi: { on: (event: string, h: (e: unknown) => unknown) => handlers.set(event, h) },
			fire: (event: string, payload: unknown) => handlers.get(event)?.(payload),
			registered: () => [...handlers.keys()],
		};
	}

	test("answers resources_discover with the discovered paths", () => {
		const { pi, fire } = fakePi();
		registerHandlers(pi as never, (cwd) => [`${cwd}/.claude/skills`]);
		expect(fire("resources_discover", { cwd: "/repo" })).toEqual({
			skillPaths: ["/repo/.claude/skills"],
		});
	});

	// pi merges whatever it gets back; an event with no cwd must contribute
	// nothing rather than a path resolved against this process's cwd.
	test("contributes nothing when the event carries no cwd", () => {
		const { pi, fire } = fakePi();
		registerHandlers(pi as never, () => ["/should/not/appear"]);
		expect(fire("resources_discover", {})).toEqual({});
	});

	test("registers only resources_discover", () => {
		const { pi, registered } = fakePi();
		registerHandlers(pi as never);
		expect(registered()).toEqual(["resources_discover"]);
	});
});
