import { describe, expect, it } from "bun:test";
import { PermissionLedger } from "../denials.ts";
import { PermissionsMenuView } from "./menu.ts";
import { ago, type MenuEffect, PermissionsMenu } from "./menu-state.ts";

const plain = { fg: (_slot: string, text: string) => text, bold: (text: string) => text };

function setup() {
	const ledger = new PermissionLedger(() => 0);
	ledger.record({ toolCallId: "c1", toolName: "bash", input: { command: "rm -rf build" }, reason: "Deletes files." });
	ledger.record({ toolCallId: "c2", toolName: "write", input: { path: "/etc/hosts", content: "x" }, reason: "System file." });
	const menu = new PermissionsMenu(ledger);
	const effects: MenuEffect[] = [];
	const view = new PermissionsMenuView(menu, plain, (e) => effects.push(e), () => 30, () => 120_000);
	return { ledger, menu, effects, view };
}

describe("the /permissions menu", () => {
	it("lists what was blocked, newest first, the selected one opened up", () => {
		const { view } = setup();
		const lines = view.render(80);
		expect(lines[0]).toContain("Denied (2)");
		expect(lines[0]).toContain("Allowed (0)");
		const first = lines.findIndex((l) => l.includes("Write(/etc/hosts)"));
		const second = lines.findIndex((l) => l.includes("Bash(rm -rf build)"));
		expect(first).toBeGreaterThan(0);
		expect(second).toBeGreaterThan(first);
		expect(lines[first]).toStartWith("❯ ● Write(/etc/hosts)");
		expect(lines[first]).toContain("2m ago");
		// The selected denial shows its input.
		expect(lines.some((l) => l.includes('"content": "x"'))).toBe(true);
	});

	it("approves or dismisses the selected denial, and revokes from the other tab", () => {
		const { view, effects, ledger, menu } = setup();
		view.handleInput("j");
		view.handleInput("a");
		expect(effects.at(-1)).toMatchObject({ kind: "approve", denial: { toolCallId: "c1" } });
		ledger.approve((effects.at(-1) as { denial: { id: string } }).denial.id);
		menu.settle();
		view.handleInput("x");
		expect(effects.at(-1)).toMatchObject({ kind: "dismiss", denial: { toolCallId: "c2" } });
		view.handleInput("\t");
		expect(view.render(80)[0]).toContain("Allowed (1)");
		view.handleInput("x");
		expect(effects.at(-1)).toMatchObject({ kind: "revoke", grant: { toolName: "bash" } });
		view.handleInput("\x1b");
		expect(effects.at(-1)).toEqual({ kind: "close" });
	});

	it("says when there is nothing to show", () => {
		const menu = new PermissionsMenu(new PermissionLedger());
		const view = new PermissionsMenuView(menu, plain, () => {}, () => 30);
		expect(view.render(80)).toContain("Nothing blocked is waiting.");
	});

	it("tells time the short way", () => {
		expect(ago(0, 2_000)).toBe("just now");
		expect(ago(0, 40_000)).toBe("40s ago");
		expect(ago(0, 12 * 60_000)).toBe("12m ago");
		expect(ago(0, 3 * 3_600_000)).toBe("3h ago");
	});
});
