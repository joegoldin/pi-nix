import { describe, expect, it } from "bun:test";
import { SPINNER_FRAMES, TitleSpinner, baseTitle, spinnerTitle } from "./title.ts";

describe("baseTitle", () => {
	it("names the working directory", () => {
		expect(baseTitle("/home/joe/src/pi-nix")).toBe("pi-nix");
	});

	it("prefers the session name when there is one", () => {
		expect(baseTitle("/home/joe/src/pi-nix", "refactor stash")).toBe("refactor stash");
	});

	it("ignores an empty session name", () => {
		expect(baseTitle("/home/joe/src/pi-nix", "")).toBe("pi-nix");
	});

	it("survives a trailing slash", () => {
		expect(baseTitle("/home/joe/src/pi-nix/")).toBe("pi-nix");
	});

	it("falls back to a fixed name at the filesystem root", () => {
		expect(baseTitle("/")).toBe("pi");
	});
});

describe("spinnerTitle", () => {
	it("puts the frame in front of the base", () => {
		expect(spinnerTitle("pi-nix", 0)).toBe(`${SPINNER_FRAMES[0]} pi-nix`);
	});

	it("cycles through every frame", () => {
		expect(spinnerTitle("x", SPINNER_FRAMES.length)).toBe(`${SPINNER_FRAMES[0]} x`);
	});
});

describe("TitleSpinner", () => {
	function recorder() {
		const painted: string[] = [];
		return { painted, spinner: new TitleSpinner((title) => painted.push(title)) };
	}

	it("paints the first frame on start", () => {
		const { painted, spinner } = recorder();
		spinner.start("pi-nix");
		spinner.stop();
		expect(painted[0]).toBe(`${SPINNER_FRAMES[0]} pi-nix`);
	});

	it("advances a frame on each tick", () => {
		const { painted, spinner } = recorder();
		spinner.start("pi-nix");
		spinner.tick();
		spinner.stop();
		expect(painted[1]).toBe(`${SPINNER_FRAMES[1]} pi-nix`);
	});

	// The title belongs to the terminal tab, not to this extension: a session
	// that goes idle must look exactly as it did before the agent started.
	it("restores the base title on stop", () => {
		const { painted, spinner } = recorder();
		spinner.start("pi-nix");
		spinner.tick();
		spinner.stop();
		expect(painted[painted.length - 1]).toBe("pi-nix");
	});

	it("ignores a second start, so two events do not double the frame rate", () => {
		const { painted, spinner } = recorder();
		spinner.start("pi-nix");
		spinner.start("pi-nix");
		spinner.stop();
		expect(painted).toEqual([`${SPINNER_FRAMES[0]} pi-nix`, "pi-nix"]);
	});

	it("does nothing on a stop it never started", () => {
		const { painted, spinner } = recorder();
		spinner.stop();
		expect(painted).toEqual([]);
	});

	it("ticks do nothing once stopped", () => {
		const { painted, spinner } = recorder();
		spinner.start("pi-nix");
		spinner.stop();
		spinner.tick();
		expect(painted).toHaveLength(2);
	});

	// setTitle is a no-op outside a real terminal but not guaranteed harmless
	// in every mode, and a spinner must never be the thing that ends a session.
	it("survives a setTitle that throws", () => {
		const spinner = new TitleSpinner(() => {
			throw new Error("no tty");
		});
		expect(() => {
			spinner.start("pi-nix");
			spinner.tick();
			spinner.stop();
		}).not.toThrow();
	});
});
