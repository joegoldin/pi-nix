import { describe, expect, it } from "bun:test";
import { DEFAULT_GIT_EDITOR, gitEditorOverrides } from "./gitenv.ts";

describe("gitEditorOverrides", () => {
	// Without this, `git commit` inside a tool call opens vi on a terminal the
	// agent does not control and the session waits forever.
	it("sets both git editor variables when neither is set", () => {
		expect(gitEditorOverrides({})).toEqual({
			GIT_EDITOR: DEFAULT_GIT_EDITOR,
			GIT_SEQUENCE_EDITOR: DEFAULT_GIT_EDITOR,
		});
	});

	it("leaves a deliberate GIT_EDITOR alone", () => {
		expect(gitEditorOverrides({ GIT_EDITOR: "code --wait" })).toEqual({
			GIT_SEQUENCE_EDITOR: DEFAULT_GIT_EDITOR,
		});
	});

	it("leaves a deliberate GIT_SEQUENCE_EDITOR alone", () => {
		expect(gitEditorOverrides({ GIT_SEQUENCE_EDITOR: "vim" })).toEqual({
			GIT_EDITOR: DEFAULT_GIT_EDITOR,
		});
	});

	it("treats an empty value as unset, because git does too", () => {
		expect(gitEditorOverrides({ GIT_EDITOR: "" }).GIT_EDITOR).toBe(DEFAULT_GIT_EDITOR);
	});

	it("adds nothing when both are already set", () => {
		expect(gitEditorOverrides({ GIT_EDITOR: "a", GIT_SEQUENCE_EDITOR: "b" })).toEqual({});
	});

	// Nix bakes an absolute store path so the jail needs nothing on PATH.
	it("uses the override binary when one is baked in", () => {
		expect(gitEditorOverrides({ PI_EXTRAS_GIT_EDITOR: "/nix/store/x/bin/true" }).GIT_EDITOR).toBe(
			"/nix/store/x/bin/true",
		);
	});

	// EDITOR is deliberately untouched: pi's ctrl+g external editor falls back
	// to it, and a non-interactive value there would silently break that.
	it("never touches EDITOR or VISUAL", () => {
		const overrides = gitEditorOverrides({});
		expect(overrides.EDITOR).toBeUndefined();
		expect(overrides.VISUAL).toBeUndefined();
	});
});
