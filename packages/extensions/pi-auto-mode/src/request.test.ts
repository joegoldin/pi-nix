import { describe, expect, it } from "bun:test";
import { renderRequest, stableStringify } from "./request.ts";

describe("stableStringify", () => {
	it("sorts keys so the classifier prompt is deterministic", () => {
		expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	it("recurses into nested objects and arrays", () => {
		expect(stableStringify({ z: [{ y: 1, x: 2 }] })).toBe('{"z":[{"x":2,"y":1}]}');
	});
});

describe("renderRequest", () => {
	it("renders bash from input.command", () => {
		const r = renderRequest({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "bash",
			input: { command: "rm -rf build" },
		} as never);
		expect(r).toEqual({
			toolName: "bash",
			toolCallId: "c1",
			surface: "bash",
			value: "rm -rf build",
			input: { command: "rm -rf build" },
		});
	});

	it("renders read, write, and edit from input.path", () => {
		for (const toolName of ["read", "write", "edit"] as const) {
			const r = renderRequest({
				type: "tool_call",
				toolCallId: "c",
				toolName,
				input: { path: "/etc/hosts" },
			} as never);
			expect(r.value).toBe("/etc/hosts");
			expect(r.surface).toBe(toolName === "read" ? "read" : "write");
		}
	});

	it("renders grep and find from the search root, falling back to the pattern", () => {
		expect(
			renderRequest({
				type: "tool_call",
				toolCallId: "c",
				toolName: "grep",
				input: { pattern: "TODO", path: "src" },
			} as never).value,
		).toBe("src");
		expect(
			renderRequest({
				type: "tool_call",
				toolCallId: "c",
				toolName: "find",
				input: { pattern: "**/*.ts" },
			} as never).value,
		).toBe("**/*.ts");
	});

	it("renders ls with an explicit cwd marker when path is omitted", () => {
		expect(renderRequest({ type: "tool_call", toolCallId: "c", toolName: "ls", input: {} } as never).value).toBe(".");
	});

	it("renders an unknown tool as sorted JSON on the generic tool surface", () => {
		const r = renderRequest({
			type: "tool_call",
			toolCallId: "c",
			toolName: "my_ext:deploy",
			input: { env: "prod", dry: false },
		} as never);
		expect(r.surface).toBe("tool");
		expect(r.value).toBe('{"dry":false,"env":"prod"}');
		expect(r.toolName).toBe("my_ext:deploy");
	});

	it("tolerates a missing input object", () => {
		const r = renderRequest({ type: "tool_call", toolCallId: "c", toolName: "bash" } as never);
		expect(r.value).toBe("");
		expect(r.input).toEqual({});
	});
});
