import { expect, test } from "bun:test";
import { showHistory } from "./history.ts";
import { CALL_TYPE } from "./state.ts";

test("full history scrolls to its end, escapes terminal controls and closes without inference", async () => {
	const entries = [
		{
			type: "custom",
			customType: CALL_TYPE,
			data: {
				version: 1,
				id: "call",
				sessionId: "session",
				at: 1,
				phase: "response",
				text:
					"\x1b]52;c;secret\x07" +
					"long response ".repeat(400) +
					" END_SENTINEL",
			},
		},
	];
	let closed = false,
		renders = 0;
	const ctx: any = {
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "session",
		},
		modelRegistry: {
			streamSimple() {
				throw new Error("History must not infer");
			},
		},
		ui: {
			select: async (_title: string, choices: string[]) => choices[0],
			custom: async (factory: Function) => {
				const view = factory(
					{
						terminal: { rows: 28 },
						requestRender() {
							renders++;
						},
					},
					{ fg: (_slot: string, text: string) => text },
					{},
					() => {
						closed = true;
					},
				);
				const first = view.render(70).join("\n");
				expect(first).not.toContain("\x1b");
				expect(first).not.toContain("END_SENTINEL");
				view.handleInput("\x1b[F");
				expect(view.render(70).join("\n")).toContain("END_SENTINEL");
				view.handleInput("\x1b[H");
				expect(view.render(70).join("\n")).toBe(first);
				view.handleInput("\x1b");
			},
		},
	};
	await showHistory(ctx);
	expect(closed).toBe(true);
	expect(renders).toBe(2);
});
