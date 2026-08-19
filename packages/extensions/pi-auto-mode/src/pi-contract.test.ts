// A differential test against pi's own source, not a structural fake.
//
// renderRequest hard-codes the field it reads per tool (bash.command,
// read.path, grep.pattern, ...). Those names come from pi's tool schemas, and
// nothing else in this package would notice if pi renamed one: the rule matcher
// would quietly start seeing an empty value and every prefix rule would stop
// matching, which fails toward "ask" and looks like the classifier being
// chatty rather than like a bug.
//
// So read the schemas. PI_CODING_AGENT_SRC points at the unpacked pi source
// (the Nix check sets it to the same fetchFromGitHub output packages.coding-agent
// builds from). Without it the file skips, so `bun test` still works in a
// checkout with no Nix.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { renderRequest } from "./request.ts";

const SRC = process.env.PI_CODING_AGENT_SRC;
const TOOLS = SRC === undefined ? null : `${SRC}/packages/coding-agent/src/core/tools`;

function schemaOf(tool: string): string {
	return readFileSync(`${TOOLS}/${tool}.ts`, "utf8");
}

/** Field is declared on the tool's TypeBox schema object. */
function declares(source: string, field: string): boolean {
	return new RegExp(`^\\t+${field}: Type\\.(String|Optional)`, "m").test(source);
}

const describeAgainstPi = SRC === undefined ? describe.skip : describe;

describeAgainstPi("the field names renderRequest reads still exist in pi's tool schemas", () => {
	it("bash takes `command`", () => {
		expect(declares(schemaOf("bash"), "command")).toBe(true);
	});

	it("read, write, and edit all take `path`", () => {
		for (const tool of ["read", "write", "edit"]) {
			expect(declares(schemaOf(tool), "path")).toBe(true);
		}
	});

	it("grep and find take `pattern` and an optional `path`", () => {
		for (const tool of ["grep", "find"]) {
			const source = schemaOf(tool);
			expect(declares(source, "pattern")).toBe(true);
			expect(source).toMatch(/^\t+path: Type\.Optional/m);
		}
	});

	it("ls takes an optional `path`, which is why renderRequest supplies a cwd marker", () => {
		expect(schemaOf("ls")).toMatch(/^\t+path: Type\.Optional/m);
	});
});

describeAgainstPi("the ToolCallEvent union renderRequest switches on", () => {
	const types = () => readFileSync(`${SRC}/packages/coding-agent/src/core/extensions/types.ts`, "utf8");

	it("still discriminates on toolName and carries toolCallId", () => {
		const source = types();
		expect(source).toMatch(/interface ToolCallEventBase \{\n\ttype: "tool_call";\n\ttoolCallId: string;/);
	});

	it("names every tool renderRequest has a case for, plus a custom arm", () => {
		const source = types();
		for (const tool of ["bash", "read", "edit", "write", "grep", "find", "ls"]) {
			expect(source).toContain(`\ttoolName: "${tool}";`);
		}
		expect(source).toContain("export interface CustomToolCallEvent extends ToolCallEventBase {");
	});

	it("still returns block/reason from a tool_call handler, which is what the gate builds", () => {
		expect(types()).toMatch(/export interface ToolCallEventResult \{[\s\S]*?block\?: boolean;[\s\S]*?reason\?: string;/);
	});
});

describeAgainstPi("ExtensionContext still carries what the gate and the classifier reach for", () => {
	const types = () => readFileSync(`${SRC}/packages/coding-agent/src/core/extensions/types.ts`, "utf8");

	it("has hasUI, sessionManager, modelRegistry, model, and signal", () => {
		const source = types();
		const context = source.slice(source.indexOf("export interface ExtensionContext {"));
		for (const field of [
			"hasUI: boolean;",
			"sessionManager: ReadonlySessionManager;",
			"modelRegistry: ModelRegistry;",
			"model: Model<any> | undefined;",
			"signal: AbortSignal | undefined;",
		]) {
			expect(context).toContain(field);
		}
	});

	it("still exposes complete() on the registry the classifier calls", () => {
		const registry = readFileSync(`${SRC}/packages/coding-agent/src/core/model-registry.ts`, "utf8");
		expect(registry).toContain("Synchronous compatibility facade exposed to extensions.");
		expect(registry).toMatch(/\tcomplete<TApi extends Api>\(\n\t\tmodel: Model<TApi>,\n\t\tcontext: Context,/);
		expect(registry).toMatch(/\tfind\(provider: string, modelId: string\)/);
	});
});

describeAgainstPi("renderRequest against literal inputs taken from pi's own schema descriptions", () => {
	it("reads a bash command out of the same field pi validates", () => {
		expect(renderRequest({ type: "tool_call", toolCallId: "c", toolName: "bash", input: { command: "ls" } } as never)).toMatchObject(
			{ surface: "bash", value: "ls" },
		);
	});
});
