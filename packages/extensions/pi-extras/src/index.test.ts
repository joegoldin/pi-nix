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

	const widgets = new Map<string, string[] | undefined>();
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
			setWidget: (key: string, content: string[] | undefined) => {
				calls.push(content === undefined ? `widget-clear:${key}` : `widget:${key}`);
				widgets.set(key, content);
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
		width: () => 80,
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
		widgets,
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
	it("ctrl+g s sets the current input aside and empties the editor", async () => {
		const h = harness();
		const s = session(h);
		h.setText("a draft");
		h.press("\x07", "s");
		await s.settled();
		expect(h.text()).toBe("");
		expect(s.stash.list()).toEqual(["a draft"]);
	});

	it("ctrl+g u brings the newest draft back", async () => {
		const h = harness();
		const s = session(h);
		h.setText("a draft");
		h.press("\x07", "s");
		await s.settled();
		expect(h.text()).toBe("");
		h.press("\x07", "u");
		await s.settled();
		expect(h.text()).toBe("a draft");
		expect(s.stash.list()).toEqual([]);
	});

	it("ctrl+g s twice stashes twice, rather than putting one back", async () => {
		// The old binding toggled on whether the editor was empty, which made
		// the same key mean two things depending on state.
		const h = harness();
		const s = session(h);
		h.setText("first");
		h.press("\x07", "s");
		await s.settled();
		h.setText("second");
		h.press("\x07", "s");
		await s.settled();
		expect(s.stash.list()).toEqual(["second", "first"]);
	});

	it("ctrl+g U empties the stash into the prompt, newest first", async () => {
		const h = harness();
		const s = session(h);
		for (const draft of ["first", "second"]) {
			h.setText(draft);
			h.press("\x07", "s");
			await s.settled();
		}
		h.press("\x07", "U");
		await s.settled();
		expect(h.text()).toBe("second\n\nfirst");
		expect(s.stash.list()).toEqual([]);
	});

	it("keeps what is already typed when unstashing onto it", async () => {
		const h = harness();
		const s = session(h);
		h.setText("stashed");
		h.press("\x07", "s");
		await s.settled();
		h.setText("in progress");
		h.press("\x07", "u");
		await s.settled();
		expect(h.text()).toBe("in progress\n\nstashed");
	});

	it("says so when there is nothing to stash", async () => {
		const h = harness();
		const s = session(h);
		h.setText("   ");
		h.press("\x07", "s");
		await s.settled();
		expect(h.notified.join(" ")).toContain("nothing to stash");
	});

	it("says so when there is nothing to restore", async () => {
		const h = harness();
		const s = session(h);
		h.press("\x07", "s");
		await s.settled();
		expect(h.notified.join(" ")).toContain("stash");
	});

	it("ctrl+g u puts back the text the stash took away", async () => {
		const h = harness();
		const s = session(h);
		h.setText("a draft");
		h.press("\x07", "s");
		await s.settled();
		h.press("\x07", "u");
		await s.settled();
		expect(h.text()).toBe("a draft");
	});


	it("ctrl+g c copies the input without changing it", async () => {
		const h = harness();
		const s = session(h);
		h.setText("copy me");
		h.press("\x07", "c");
		await s.settled();
		expect(h.copied).toEqual(["copy me"]);
		expect(h.text()).toBe("copy me");
	});

	it("ctrl+g x copies and then clears", async () => {
		const h = harness();
		const s = session(h);
		h.setText("cut me");
		h.press("\x07", "x");
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
		h.press("\x07", "x");
		await s.settled();
		expect(h.text()).toBe("cut me");
	});

	it("a copy that finds no clipboard tool degrades quietly", async () => {
		const h = harness({ runClipboard: async () => false });
		const s = session(h);
		h.setText("copy me");
		h.press("\x07", "c");
		await s.settled();
		expect(h.text()).toBe("copy me");
		expect(h.copied).toEqual([]);
	});




	// Append reads, never consumes: the same snippet is usually wanted twice.
	it("appending leaves the register in place", async () => {
		const h = harness();
		const s = session(h);
		h.setText("kept");
		h.press("\x07", "s");
		await s.settled();
		h.press("\x07", "a", "0");
		await s.settled();
		expect(s.stash.list()).toEqual(["kept"]);
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
		expect(h.consumed("\x07")).toBe(true);
		expect(h.consumed("s")).toBe(true);
	});

	it("consumes ctrl+s, which acts without a chord at all", () => {
		const h = harness();
		session(h);
		expect(h.consumed("\x13")).toBe(true);
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
		expect(h.consumed("\x07")).toBe(true);
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

	it("/stash opens the list as a widget, leaving the prompt in place", async () => {
		// It used to mount through ctx.ui.custom, whose non-overlay branch swaps
		// the component into the editor's own container -- which is why the
		// prompt disappeared under the list.
		const h = started();
		await h.commands.get("stash")?.("", h.ctx as never);
		expect(h.calls).toContain("widget:pi-extras:stash");
		expect(h.calls).not.toContain("custom");
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

describe("ctrl+s, the quick toggle", () => {
	it("stashes when there is a prompt to stash", async () => {
		const h = harness();
		const s = session(h);
		h.setText("a draft");
		h.press("\x13");
		await s.settled();
		expect(h.text()).toBe("");
		expect(s.stash.list()).toEqual(["a draft"]);
	});

	it("brings the last one back when the prompt is empty", async () => {
		const h = harness();
		const s = session(h);
		h.setText("a draft");
		h.press("\x13");
		await s.settled();
		h.press("\x13");
		await s.settled();
		expect(h.text()).toBe("a draft");
		expect(s.stash.list()).toEqual([]);
	});

	it("takes the newest first, leaving the rest", async () => {
		const h = harness();
		const s = session(h);
		for (const draft of ["first", "second"]) {
			h.setText(draft);
			h.press("\x13");
			await s.settled();
		}
		h.press("\x13");
		await s.settled();
		expect(h.text()).toBe("second");
		expect(s.stash.list()).toEqual(["first"]);
	});

	it("says so when there is nothing either way", async () => {
		const h = harness();
		const s = session(h);
		h.press("\x13");
		await s.settled();
		expect(h.notified.join(" ")).toContain("the stash is empty");
	});

	it("needs no second key, so nothing is left pending", () => {
		const h = harness();
		session(h);
		expect(h.consumed("\x13")).toBe(true);
		// The next letter is the prompt's, not a chord's.
		expect(h.consumed("s")).toBe(false);
	});
});

describe("the stash list as a widget", () => {
	const openWith = async (drafts: string[]) => {
		const h = harness();
		const s = session(h);
		for (const draft of drafts) {
			h.setText(draft);
			h.press("\x13");
			await s.settled();
		}
		h.press("\x07", "l");
		await s.settled();
		return { h, s };
	};

	it("draws above the editor, so the prompt stays on screen", async () => {
		const { h } = await openWith(["alpha"]);
		expect(h.widgets.get("pi-extras:stash")?.join("\n")).toContain("alpha");
	});

	it("swallows every key while it is open", async () => {
		const { h } = await openWith(["alpha"]);
		// Not bound to anything in the list, and it must not reach the prompt.
		expect(h.consumed("Q")).toBe(true);
	});

	it("clears the widget when it closes, rather than leaving it drawn", async () => {
		const { h, s } = await openWith(["alpha"]);
		h.press("\x1b");
		await s.settled();
		expect(h.widgets.get("pi-extras:stash")).toBeUndefined();
	});

	it("gives keys back to the chord once it has closed", async () => {
		const { h, s } = await openWith(["alpha"]);
		h.press("\x1b");
		await s.settled();
		expect(h.consumed("Q")).toBe(false);
	});

	it("appends a restored draft rather than replacing the prompt", async () => {
		const { h, s } = await openWith(["stashed"]);
		h.setText("in progress");
		h.press("\r");
		await s.settled();
		expect(h.text()).toBe("in progress\n\nstashed");
	});
});
