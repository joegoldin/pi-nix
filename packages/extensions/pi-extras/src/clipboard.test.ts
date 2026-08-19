import { describe, expect, it } from "bun:test";
import { type ClipboardTarget, clipboardTargets, copyToClipboard } from "./clipboard.ts";

describe("clipboardTargets", () => {
	// Wayland first: that is the session this runs in, and wl-copy is the only
	// one of the three that works there without an X server.
	it("defaults to the wl-copy, xclip, pbcopy chain", () => {
		expect(clipboardTargets({}).map((t) => t.command)).toEqual(["wl-copy", "xclip", "pbcopy"]);
	});

	it("gives xclip the clipboard selection, which is not its default", () => {
		const xclip = clipboardTargets({}).find((t) => t.command === "xclip");
		expect(xclip?.args).toEqual(["-selection", "clipboard"]);
	});

	// Nix bakes an absolute store path here, because nothing is on PATH inside
	// the jail unless a permission put it there.
	it("uses the override alone when one is set", () => {
		expect(clipboardTargets({ PI_EXTRAS_CLIPBOARD: "/nix/store/x/bin/wl-copy" })).toEqual([
			{ command: "/nix/store/x/bin/wl-copy", args: [] },
		]);
	});

	it("derives the override's arguments from its basename", () => {
		expect(clipboardTargets({ PI_EXTRAS_CLIPBOARD: "/nix/store/x/bin/xclip" })[0]?.args).toEqual([
			"-selection",
			"clipboard",
		]);
	});

	it("treats an empty override as unset", () => {
		expect(clipboardTargets({ PI_EXTRAS_CLIPBOARD: "" })).toHaveLength(3);
	});
});

describe("copyToClipboard", () => {
	const targets: ClipboardTarget[] = [
		{ command: "wl-copy", args: [] },
		{ command: "xclip", args: ["-selection", "clipboard"] },
	];

	it("stops at the first target that works", async () => {
		const tried: string[] = [];
		const ok = await copyToClipboard("text", targets, async (target) => {
			tried.push(target.command);
			return true;
		});
		expect(ok).toBe(true);
		expect(tried).toEqual(["wl-copy"]);
	});

	it("falls through to the next target when the first is missing", async () => {
		const tried: string[] = [];
		const ok = await copyToClipboard("text", targets, async (target) => {
			tried.push(target.command);
			return target.command === "xclip";
		});
		expect(ok).toBe(true);
		expect(tried).toEqual(["wl-copy", "xclip"]);
	});

	// No clipboard tool anywhere is an ordinary state on a headless host. The
	// copy chord loses its effect; nothing else does.
	it("reports failure instead of throwing when nothing exists", async () => {
		expect(await copyToClipboard("text", targets, async () => false)).toBe(false);
	});

	it("survives a runner that throws", async () => {
		const ok = await copyToClipboard("text", targets, async (target) => {
			if (target.command === "wl-copy") throw new Error("ENOENT");
			return true;
		});
		expect(ok).toBe(true);
	});

	it("reports failure with no targets at all", async () => {
		expect(await copyToClipboard("text", [], async () => true)).toBe(false);
	});

	it("passes the text through to the runner", async () => {
		let seen: string | undefined;
		await copyToClipboard("payload", targets, async (_target, text) => {
			seen = text;
			return true;
		});
		expect(seen).toBe("payload");
	});
});
