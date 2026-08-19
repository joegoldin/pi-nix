import { describe, expect, it } from "bun:test";
import type { ClipboardTarget } from "./clipboard.ts";
import { type ExtrasContext, type ExtrasDeps, type ExtrasHost, ExtrasSession, registerHandlers } from "./index.ts";

const TARGETS: ClipboardTarget[] = [{ command: "wl-copy", args: [] }];

function harness(overrides: Partial<ExtrasDeps> = {}) {
	let editorText = "";
	let thinkingLevel = "off";
	let file: string | undefined;
	const copied: string[] = [];
	const notified: string[] = [];
	const pasted: string[] = [];
	const titles: string[] = [];
	const envApplied: Record<string, string> = {};
	const calls: string[] = [];
	const handlers = new Map<string, (payload: never, ctx: never) => unknown>();
	const commands = new Map<string, (args: string, ctx: never) => Promise<void>>();
	let keys: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;

	const pi: ExtrasHost = {
		on: (event, handler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name, options) => {
			commands.set(name, options.handler);
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level) => {
			thinkingLevel = level;
		},
	};

	const ctx = {
		cwd: "/repo",
		mode: "tui",
		ui: {
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
			pasteToEditor: (text: string) => {
				pasted.push(text);
			},
			notify: (message: string) => {
				notified.push(message);
			},
			onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				keys = handler;
				return () => {
					keys = undefined;
				};
			},
			setTitle: (title: string) => {
				titles.push(title);
			},
			custom: async () => {
				calls.push("custom");
			},
			theme: { fg: (_slot: string, text: string) => text },
		},
		sessionManager: {
			getSessionName: () => undefined,
			getLeafId: () => "leaf-1",
		},
		shutdown: () => {
			calls.push("shutdown");
		},
		newSession: async () => {
			calls.push("newSession");
			return { cancelled: false };
		},
		fork: async (entryId: string, options?: { position?: string }) => {
			calls.push(`fork:${entryId}:${options?.position}`);
			return { cancelled: false };
		},
	} as unknown as ExtrasContext;

	const deps: ExtrasDeps = {
		env: {},
		homeDir: "/home/joe",
		now: () => 0,
		exists: () => true,
		clipboard: TARGETS,
		runClipboard: async (_target, text) => {
			copied.push(text);
			return true;
		},
		applyEnv: (values) => {
			Object.assign(envApplied, values);
		},
		stashIO: {
			read: () => {
				if (file === undefined) throw new Error("ENOENT");
				return file;
			},
			write: (data) => {
				file = data;
			},
		},
		...overrides,
	};

	return {
		pi,
		ctx,
		deps,
		calls,
		copied,
		notified,
		pasted,
		titles,
		envApplied,
		commands,
		handlers,
		text: () => editorText,
		setText: (value: string) => {
			editorText = value;
		},
		thinking: () => thinkingLevel,
		press: (...data: string[]) => {
			for (const key of data) keys?.(key);
		},
		consumed: (data: string) => keys?.(data)?.consume === true,
	};
}

function session(h: ReturnType<typeof harness>): ExtrasSession {
	const s = new ExtrasSession(h.pi, h.ctx, h.deps);
	s.attach();
	return s;
}

describe("stash chords", () => {
	it("ctrl+s s sets the current input aside and empties the editor", async () => {
		const h = harness();
		const s = session(h);
		h.setText("a draft");
		h.press("\x13", "s");
		await s.settled();
		expect(h.text()).toBe("");
		expect(s.stash.list()).toEqual(["a draft"]);
	});

	it("ctrl+s s on an empty editor restores the newest draft", async () => {
		const h = harness();
		const s = session(h);
		h.setText("a draft");
		h.press("\x13", "s");
		await s.settled();
		h.press("\x13", "s");
		await s.settled();
		expect(h.text()).toBe("a draft");
		expect(s.stash.list()).toEqual([]);
	});

	it("says so when there is nothing to restore", async () => {
		const h = harness();
		const s = session(h);
		h.press("\x13", "s");
		await s.settled();
		expect(h.notified.join(" ")).toContain("stash");
	});

	it("ctrl+s u puts back the text the stash took away", async () => {
		const h = harness();
		const s = session(h);
		h.setText("a draft");
		h.press("\x13", "s");
		await s.settled();
		h.press("\x13", "u");
		await s.settled();
		expect(h.text()).toBe("a draft");
	});

	it("ctrl+s r replays what the undo took back", async () => {
		const h = harness();
		const s = session(h);
		h.setText("a draft");
		h.press("\x13", "s");
		await s.settled();
		h.press("\x13", "u");
		await s.settled();
		h.press("\x13", "r");
		await s.settled();
		expect(h.text()).toBe("");
	});

	it("ctrl+s y copies the input without changing it", async () => {
		const h = harness();
		const s = session(h);
		h.setText("copy me");
		h.press("\x13", "y");
		await s.settled();
		expect(h.copied).toEqual(["copy me"]);
		expect(h.text()).toBe("copy me");
	});

	it("ctrl+s d copies and then clears", async () => {
		const h = harness();
		const s = session(h);
		h.setText("cut me");
		h.press("\x13", "d");
		await s.settled();
		expect(h.copied).toEqual(["cut me"]);
		expect(h.text()).toBe("");
	});

	// A cut whose copy failed would destroy the text with nowhere to get it
	// back from, which is the one clipboard failure that must not be silent.
	it("a cut keeps the text when no clipboard tool exists", async () => {
		const h = harness({ runClipboard: async () => false });
		const s = session(h);
		h.setText("cut me");
		h.press("\x13", "d");
		await s.settled();
		expect(h.text()).toBe("cut me");
	});

	it("a copy that finds no clipboard tool degrades quietly", async () => {
		const h = harness({ runClipboard: async () => false });
		const s = session(h);
		h.setText("copy me");
		h.press("\x13", "y");
		await s.settled();
		expect(h.text()).toBe("copy me");
		expect(h.copied).toEqual([]);
	});

	it("ctrl+s t advances the thinking level", async () => {
		const h = harness();
		const s = session(h);
		h.press("\x13", "t");
		await s.settled();
		expect(h.thinking()).toBe("low");
		h.press("\x13", "t");
		await s.settled();
		expect(h.thinking()).toBe("medium");
	});

	it("ctrl+s a 0 appends a numbered register", async () => {
		const h = harness();
		const s = session(h);
		h.setText("first");
		h.press("\x13", "s");
		await s.settled();
		h.setText("second");
		h.press("\x13", "a", "0");
		await s.settled();
		expect(h.text()).toBe("second\nfirst");
	});

	it("ctrl+s a s appends the stash register", async () => {
		const h = harness();
		const s = session(h);
		h.setText("kept");
		h.press("\x13", "s");
		await s.settled();
		h.press("\x13", "a", "s");
		await s.settled();
		expect(h.text()).toBe("kept");
	});

	// Append reads, never consumes: the same snippet is usually wanted twice.
	it("appending leaves the register in place", async () => {
		const h = harness();
		const s = session(h);
		h.setText("kept");
		h.press("\x13", "s");
		await s.settled();
		h.press("\x13", "a", "0");
		await s.settled();
		expect(s.stash.list()).toEqual(["kept"]);
	});

	it("says so when the register is empty", async () => {
		const h = harness();
		const s = session(h);
		h.press("\x13", "a", "4");
		await s.settled();
		expect(h.notified.join(" ")).toContain("4");
	});

	it("alt+i inserts a literal tab at the cursor", async () => {
		const h = harness();
		const s = session(h);
		h.press("\x1bi");
		await s.settled();
		expect(h.pasted).toEqual(["\t"]);
	});
});

describe("chord consumption", () => {
	it("consumes the prefix and the key that completes it", () => {
		const h = harness();
		session(h);
		expect(h.consumed("\x13")).toBe(true);
		expect(h.consumed("s")).toBe(true);
	});

	it("lets ordinary typing through", () => {
		const h = harness();
		session(h);
		expect(h.consumed("s")).toBe(false);
	});

	// The chord cancels and the stray key is swallowed, so a half-typed chord
	// never leaves a letter in the prompt.
	it("swallows the key that cancels a chord, and touches nothing", async () => {
		const h = harness();
		const s = session(h);
		h.setText("untouched");
		expect(h.consumed("\x13")).toBe(true);
		expect(h.consumed("z")).toBe(true);
		await s.settled();
		expect(h.text()).toBe("untouched");
		expect(s.stash.list()).toEqual([]);
	});

	it("detach stops intercepting", () => {
		const h = harness();
		const s = session(h);
		s.detach();
		expect(h.consumed("\x13")).toBe(false);
	});
});

describe("registerHandlers", () => {
	function started(overrides: Partial<ExtrasDeps> = {}) {
		const h = harness(overrides);
		registerHandlers(h.pi, h.deps);
		h.handlers.get("session_start")?.({} as never, h.ctx as never);
		return h;
	}

	it("sets the git editor variables at session start", () => {
		expect(started().envApplied.GIT_EDITOR).toBeDefined();
	});

	it.each(["exit", "e"])("/%s shuts pi down", async (name) => {
		const h = started();
		await h.commands.get(name)?.("", h.ctx as never);
		expect(h.calls).toContain("shutdown");
	});

	it("/clear starts a new session", async () => {
		const h = started();
		await h.commands.get("clear")?.("", h.ctx as never);
		expect(h.calls).toContain("newSession");
	});

	it("/clone-session forks at the current leaf", async () => {
		const h = started();
		await h.commands.get("clone-session")?.("", h.ctx as never);
		expect(h.calls).toContain("fork:leaf-1:at");
	});

	it("/stash opens the overlay", async () => {
		const h = started();
		await h.commands.get("stash")?.("", h.ctx as never);
		expect(h.calls).toContain("custom");
	});

	it("spins the terminal title while the agent works and restores it after", async () => {
		const h = started();
		await h.handlers.get("agent_start")?.({} as never, h.ctx as never);
		await h.handlers.get("agent_settled")?.({} as never, h.ctx as never);
		expect(h.titles[0]).toContain("repo");
		expect(h.titles[h.titles.length - 1]).toBe("repo");
	});

	it("expands a tilde reference on the way in", async () => {
		const h = started();
		const result = await h.handlers.get("input")?.({ text: "read @~/notes.md" } as never, h.ctx as never);
		expect(result).toEqual({ action: "transform", text: "read @/home/joe/notes.md" });
	});

	it("leaves input with nothing to expand alone", async () => {
		const h = started();
		expect(await h.handlers.get("input")?.({ text: "plain" } as never, h.ctx as never)).toEqual({ action: "continue" });
	});

	it("warns about a reference that points at nothing, and still continues", async () => {
		const h = started({ exists: () => false });
		const result = await h.handlers.get("input")?.({ text: "read @gone.ts" } as never, h.ctx as never);
		expect(h.notified.join(" ")).toContain("@gone.ts");
		expect(result).toEqual({ action: "continue" });
	});

	// pi's rpc and print modes stub the UI down to the dialogs, so every
	// optional surface has to be reached defensively.
	it("survives a context with no terminal input, no title, and no theme", () => {
		const h = harness();
		const bare = { cwd: "/repo", mode: "rpc", ui: { notify: () => {} } } as unknown as ExtrasContext;
		registerHandlers(h.pi, h.deps);
		expect(() => h.handlers.get("session_start")?.({} as never, bare as never)).not.toThrow();
	});
});
