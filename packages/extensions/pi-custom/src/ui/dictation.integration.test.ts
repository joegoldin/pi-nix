import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEventBus, CustomEditor } from "@earendil-works/pi-coding-agent";
import { registerDictationBridge } from "./dictation.ts";
import { createPromptEditor } from "./editor.ts";

const source = process.env.PI_VOICE_SRC
	? pathToFileURL(join(process.env.PI_VOICE_SRC, "src/index.ts"))
	: new URL("../../../pi-voice/src/index.ts", import.meta.url);
const { default: registerVoice } = await import(source.href);

async function until(check: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for fake recorder");
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

for (const action of ["space", "enter", "typing", "shutdown"]) {
	test(`real recorder transport and editor: ${action} finishes without duplicate text or submission`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-inline-voice-"));
		const record = join(dir, "record");
		writeFileSync(join(dir, "final"), JSON.stringify({ type: "final", t: 2, text: "Hello, world!", source: "batch" }) + "\n");
		writeFileSync(record, [
			"#!/bin/sh",
			`trap 'cat "${dir}/final"; exit 0' INT`,
			`printf '%s\\n' '{"type":"start","t":0,"mode":"live"}' '{"type":"commit","t":1,"text":"hello"}' '{"type":"partial","t":1,"text":"world"}' '{"type":"level","t":1,"rms":0.8,"db":-12}'`,
			"while true; do sleep 0.02; done",
		].join("\n"));
		chmodSync(record, 0o755);
		process.env.PI_VOICE_RECORD_BIN = record;
		process.env.CLAUDE_CONFIG_DIR = dir;
		const Editor = createPromptEditor(CustomEditor as never, () => text => text);
		const editor = new Editor({ requestRender() {}, terminal: { rows: 24 } }, { borderColor: (text: string) => text, selectList: {} }, { matches: () => false });
		let submitted = 0;
		(editor as unknown as CustomEditor).onSubmit = () => { submitted++; };
		const events = createEventBus();
		registerDictationBridge(events, () => editor);
		const handlers = new Map<string, Function>();
		const inputHandlers = new Set<(data: string) => { consume?: boolean } | undefined>();
		const widgets: unknown[] = [], pastes: string[] = [], notices: string[] = [];
		registerVoice({ events, on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand() {} });
		const ctx = {
			mode: "tui", cwd: dir,
			ui: {
				getEditorText: () => editor.getText(),
				onEditorInput: (fn: (data: string) => { consume?: boolean } | undefined) => {
					inputHandlers.add(fn); return () => inputHandlers.delete(fn);
				},
				setWidget: (_key: string, content: unknown) => { if (content !== undefined) widgets.push(content); },
				setStatus() {}, pasteToEditor: (text: string) => pastes.push(text),
				notify: (text: string) => notices.push(text),
			},
		};
		function input(data: string) {
			for (const handler of inputHandlers) if (handler(data)?.consume) return;
			editor.handleInput(data);
		}
		try {
			await handlers.get("session_start")!({}, ctx);
			input(" ");
			input("\x1b[32;1:2u");
			input("\x1b[32;1:3u");
			await until(() => editor.getText() === "hello world");
			expect(widgets).toEqual([]);
			expect(editor.render(80).join("\n")).toMatch(/[▁▂▃▄▅▆▇█]/);
			if (action === "space") input(" ");
			else if (action === "enter") input("\r");
			else if (action === "typing") input("!");
			await handlers.get("session_shutdown")!();
			expect(editor.getText()).toBe(action === "typing" ? "hello world!" : action === "enter" ? "hello world" : "Hello, world!");
			expect(pastes).toEqual([]);
			expect(notices).toEqual([]);
			expect(submitted).toBe(0);
			expect(inputHandlers.size).toBe(0);
		} finally {
			await handlers.get("session_shutdown")!();
			delete process.env.PI_VOICE_RECORD_BIN;
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});
}
