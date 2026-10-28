import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forkSideSession, requiredSideExtensions } from "./btw-session.ts";

const dirs: string[] = [];
afterEach(() =>
	dirs
		.splice(0)
		.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "btw-session-"));
	dirs.push(dir);
	return dir;
}

test("forks the selected branch to an independent disk session without changing its parent", () => {
	const dir = directory();
	const parent = SessionManager.create(dir, dir);
	const first = parent.appendMessage({
		role: "user",
		content: "shared question",
		timestamp: 1,
	});
	parent.appendMessage({ role: "user", content: "sibling-only", timestamp: 2 });
	parent.branch(first);
	const source = parent.getSessionFile()!;
	const before = readFileSync(source, "utf8");
	const child = forkSideSession(parent, dir, join(dir, "children"));
	expect(child.getSessionId()).not.toBe(parent.getSessionId());
	expect(child.getSessionFile()).not.toBe(source);
	expect(JSON.stringify(child.buildSessionContext().messages)).toContain(
		"shared question",
	);
	expect(JSON.stringify(child.buildSessionContext().messages)).not.toContain(
		"sibling-only",
	);
	child.appendMessage({
		role: "user",
		content: "private follow-up",
		timestamp: 3,
	});
	expect(readFileSync(source, "utf8")).toBe(before);
	const resumed = SessionManager.open(child.getSessionFile()!);
	expect(JSON.stringify(resumed.buildSessionContext().messages)).toContain(
		"private follow-up",
	);
});

test("a fork records pending parent tools as not executed by the child", () => {
	const dir = directory();
	const parent = SessionManager.create(dir, dir);
	parent.appendMessage({
		role: "user",
		content: "main question",
		timestamp: 1,
	});
	parent.appendMessage({
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "pending",
				name: "read",
				arguments: { path: "source.ts" },
			},
		],
		api: "test",
		provider: "test",
		model: "test",
		stopReason: "toolUse",
		timestamp: 2,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as any);
	const child = forkSideSession(parent, dir, join(dir, "children"));
	const last = child.buildSessionContext().messages.at(-1) as any;
	expect(last.role).toBe("toolResult");
	expect(last.toolCallId).toBe("pending");
	expect(last.isError).toBe(true);
	expect(JSON.stringify(last.content)).toContain(
		"not executed by this side conversation",
	);
	expect(parent.buildSessionContext().messages.at(-1)!.role).toBe("assistant");
});

test("child gates are scoped to the parent and invalid registries fail closed", () => {
	const key = Symbol.for("pi-subagents.required-child-extensions.v1");
	const registry = {
		[key]: {
			version: 1,
			bySession: new Map([
				[
					"main",
					[
						{
							id: "pi-permissions",
							path: "/trusted/permissions.ts",
							requireForAllRunners: true,
						},
					],
				],
				["other", [{ id: "other", path: "/unrelated.ts" }]],
			]),
		},
	};
	expect(requiredSideExtensions("main", registry)).toEqual([
		"/trusted/permissions.ts",
	]);
	expect(requiredSideExtensions("empty", registry)).toEqual([]);
	expect(() => requiredSideExtensions("other", registry, true)).toThrow(
		"permission gates",
	);
	expect(() => requiredSideExtensions("empty", registry, true)).toThrow(
		"permission gates",
	);
	expect(() =>
		requiredSideExtensions("main", { [key]: { version: 99 } }),
	).toThrow();
});
