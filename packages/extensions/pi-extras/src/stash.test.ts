import { describe, expect, it } from "bun:test";
import { MAX_STASH, StashStore, stashPath } from "./stash.ts";

/** A store whose reads and writes both work, seeded with `initial`. */
function memoryStore(initial?: string): { store: StashStore; written: () => string | undefined } {
	let file = initial;
	const store = new StashStore({
		read: () => {
			if (file === undefined) throw new Error("ENOENT");
			return file;
		},
		write: (data) => {
			file = data;
		},
	});
	return { store, written: () => file };
}

describe("stashPath", () => {
	it("honours PI_CODING_AGENT_DIR", () => {
		expect(stashPath({ PI_CODING_AGENT_DIR: "/etc/pi" }, "/home/joe")).toBe("/etc/pi/pi-extras/stash.json");
	});

	it("falls back to $HOME/.pi/agent", () => {
		expect(stashPath({}, "/home/joe")).toBe("/home/joe/.pi/agent/pi-extras/stash.json");
	});

	it("treats an empty override as unset", () => {
		expect(stashPath({ PI_CODING_AGENT_DIR: "" }, "/home/joe")).toBe("/home/joe/.pi/agent/pi-extras/stash.json");
	});

	// pi expands a leading tilde in this variable itself, so a store that did
	// not would write to a literal "~" directory beside the real one.
	it("expands a leading tilde", () => {
		expect(stashPath({ PI_CODING_AGENT_DIR: "~/alt" }, "/home/joe")).toBe("/home/joe/alt/pi-extras/stash.json");
	});
});

describe("StashStore", () => {
	it("starts empty and persists a push", () => {
		const { store, written } = memoryStore();
		store.push("draft one");
		expect(store.list()).toEqual(["draft one"]);
		expect(JSON.parse(written() ?? "")).toEqual({ version: 1, entries: ["draft one"] });
	});

	it("reads entries written by an earlier session", () => {
		const { store } = memoryStore(JSON.stringify({ version: 1, entries: ["older"] }));
		expect(store.list()).toEqual(["older"]);
	});

	it("puts the newest draft first", () => {
		const { store } = memoryStore();
		store.push("first");
		store.push("second");
		expect(store.list()).toEqual(["second", "first"]);
	});

	it("ignores an empty or whitespace-only draft", () => {
		const { store } = memoryStore();
		store.push("   \n ");
		store.push("");
		expect(store.list()).toEqual([]);
	});

	// Hitting the stash chord twice on the same text is a slip, not a request
	// for two identical entries.
	it("does not duplicate the entry already on top", () => {
		const { store } = memoryStore();
		store.push("same");
		store.push("same");
		expect(store.list()).toEqual(["same"]);
	});

	it("caps the stash, dropping the oldest", () => {
		const { store } = memoryStore();
		for (let i = 0; i <= MAX_STASH; i++) store.push(`draft ${i}`);
		expect(store.list()).toHaveLength(MAX_STASH);
		expect(store.list()[MAX_STASH - 1]).toBe("draft 1");
	});

	// Restore is a pop, so repeated restores walk back through the stack the
	// way `git stash pop` does.
	it("restore removes the entry it returns", () => {
		const { store } = memoryStore();
		store.push("a");
		store.push("b");
		expect(store.restore()).toBe("b");
		expect(store.list()).toEqual(["a"]);
	});

	it("restore returns undefined when the stash is empty", () => {
		expect(memoryStore().store.restore()).toBeUndefined();
	});

	it("restores an entry by index", () => {
		const { store } = memoryStore();
		store.push("a");
		store.push("b");
		expect(store.restore(1)).toBe("a");
		expect(store.list()).toEqual(["b"]);
	});

	// Append reads a register without consuming it: the same snippet is usually
	// wanted in more than one prompt.



	it("removes and clears", () => {
		const { store } = memoryStore();
		store.push("a");
		store.push("b");
		store.remove(0);
		expect(store.list()).toEqual(["a"]);
		store.clear();
		expect(store.list()).toEqual([]);
	});

	it("ignores a remove past the end", () => {
		const { store } = memoryStore();
		store.push("a");
		store.remove(9);
		expect(store.list()).toEqual(["a"]);
	});
});

describe("StashStore degradation", () => {
	// A first run has no file at all, which reads exactly like a broken one.
	it("starts empty when the file cannot be read, and still persists", () => {
		const { store, written } = memoryStore();
		expect(store.list()).toEqual([]);
		expect(store.persistent).toBe(true);
		store.push("a");
		expect(written()).toBeDefined();
	});

	it("starts empty on malformed JSON rather than throwing", () => {
		const { store } = memoryStore("{not json");
		expect(store.list()).toEqual([]);
	});

	it("ignores a file whose entries are not strings", () => {
		const { store } = memoryStore(JSON.stringify({ version: 1, entries: [1, null, "keep"] }));
		expect(store.list()).toEqual(["keep"]);
	});

	// The behaviour this store exists to guarantee: an unwritable agent dir
	// costs persistence across sessions and nothing else.
	it("keeps working in memory when the write fails", () => {
		const store = new StashStore({
			read: () => {
				throw new Error("ENOENT");
			},
			write: () => {
				throw new Error("EACCES");
			},
		});
		store.push("a");
		store.push("b");
		expect(store.list()).toEqual(["b", "a"]);
		expect(store.restore()).toBe("b");
		expect(store.persistent).toBe(false);
		expect(store.drain()).toEqual(["a"]);
		expect(store.list()).toEqual([]);
	});

	it("keeps working with no io at all", () => {
		const store = new StashStore(undefined);
		store.push("a");
		expect(store.list()).toEqual(["a"]);
		expect(store.persistent).toBe(false);
	});

	// One failed write must not turn every later operation into a retry storm
	// against a directory that is not going to start working.
	it("stops retrying after the first write failure", () => {
		let attempts = 0;
		const store = new StashStore({
			read: () => "",
			write: () => {
				attempts++;
				throw new Error("EACCES");
			},
		});
		store.push("a");
		store.push("b");
		expect(attempts).toBe(1);
	});
});
