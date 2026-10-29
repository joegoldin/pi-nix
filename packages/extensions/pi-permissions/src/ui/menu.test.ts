import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PermissionLedger } from "../denials.ts";
import { PermissionsMenuView } from "./menu.ts";
import { ago, type MenuEffect, PermissionsMenu, type SettingRow } from "./menu-state.ts";

const plain = { fg: (_slot: string, text: string) => text, bold: (text: string) => text };

function setup() {
	const ledger = new PermissionLedger(() => 0);
	ledger.record({ toolCallId: "c1", toolName: "bash", input: { command: "rm -rf build" }, reason: "Deletes files." });
	ledger.record({ toolCallId: "c2", toolName: "write", input: { path: "/etc/hosts", content: "x" }, reason: "System file." });
	const autoRows: SettingRow[] = [
		{ id: "toggle", label: "Auto mode", value: "on", description: "Classify calls.", actionable: true },
		{ id: "ask", label: "Ask before a block", value: "on, 30s", actionable: false },
	];
	const settingRows: SettingRow[] = [{ id: "yoloMode", label: "YOLO mode", value: "off", actionable: true }];
	const menu = new PermissionsMenu(ledger, { auto: () => autoRows, settings: () => settingRows });
	const effects: MenuEffect[] = [];
	const view = new PermissionsMenuView(menu, plain, (e) => effects.push(e), () => 30, () => 120_000);
	return { ledger, menu, effects, view };
}

describe("the /permissions menu", () => {
	it("Ctrl+P closes every tab and expanded denial details without taking an action", () => {
		for (const tab of ["denied", "granted", "auto", "settings"] as const) {
			const { view, effects, menu } = setup();
			menu.tab = tab;
			view.handleInput("\x10");
			expect(effects).toEqual([{ kind: "close" }]);
		}
		const { view, effects, ledger } = setup();
		view.handleInput("e");
		view.handleInput("\x10");
		expect(effects).toEqual([{ kind: "close" }]);
		expect(ledger.open()).toHaveLength(2);
		expect(ledger.grantList()).toEqual([]);
	});

	it("lists what was blocked, newest first, with compact reason excerpts", () => {
		const { view } = setup();
		const lines = view.render(80);
		expect(lines[0]).toContain("Denied (2)");
		expect(lines[0]).toContain("Allowed (0)");
		expect(lines[0]).toContain("Auto mode");
		expect(lines[0]).toContain("Settings");
		const first = lines.findIndex((l) => l.includes("Write(/etc/hosts)"));
		const second = lines.findIndex((l) => l.includes("Bash(rm -rf build)"));
		expect(first).toBeGreaterThan(0);
		expect(second).toBeGreaterThan(first);
		expect(lines[first]).toStartWith("❯ ● Write(/etc/hosts)");
		expect(lines[first]).toContain("2m ago");
		// Input is reserved for the explanation view.
		expect(lines.some((l) => l.includes('"content": "x"'))).toBe(false);
		expect(lines).toContain("     Denied: System file.");
		expect(lines.at(-1)).toContain("e explain");
	});

	it("explains the selected denial without approving it, then returns to the same row", () => {
		const { view, effects, menu } = setup();
		view.handleInput("j");
		view.handleInput("e");
		const lines = view.render(80);
		expect(lines).toContain("Reason");
		expect(lines).toContain("Deletes files.");
		expect(lines).toContain("Command");
		expect(lines).toContain("rm -rf build");
		expect(lines).toContain('  "command": "rm -rf build"');
		for (const key of ["x", "\t"]) view.handleInput(key);
		expect(effects).toHaveLength(0);
		view.handleInput("\x1b");
		expect(menu.cursor).toBe(1);
		expect(view.render(80).some((l) => l.startsWith("❯ ● Bash"))).toBe(true);
		expect(effects).toHaveLength(0);
	});

	it("keeps long reasons compact but makes the entire reason and input scrollable", () => {
		const { ledger, menu, effects } = setup();
		const reason = "[pi-permission-system] " + "Long denial reason. ".repeat(30) + "REASON_END";
		const command = "printf " + "long-command-".repeat(30) + "COMMAND_END";
		ledger.record({ toolCallId: "long", toolName: "bash", input: { command, tail: "INPUT_END" }, reason });
		const view = new PermissionsMenuView(menu, plain, (e) => effects.push(e), () => 12);
		const compact = view.render(60);
		expect(compact.some((l) => l.includes("REASON_END"))).toBe(false);
		expect(compact.filter((l) => l.includes("Long denial"))).toHaveLength(1);
		view.handleInput("e");
		let seen = "";
		for (let i = 0; i < 150; i++) {
			const lines = view.render(60);
			expect(lines.length).toBeLessThanOrEqual(12);
			expect(lines.every((l) => visibleWidth(l) <= 60)).toBe(true);
			seen += lines.join("\n");
			view.handleInput("j");
		}
		expect(seen).toContain("[pi-permission-system]");
		expect(seen).toContain("REASON_END");
		expect(seen).toContain("COMMAND_END");
		expect(seen).toContain("INPUT_END");
		for (let i = 0; i < 150; i++) view.handleInput("k");
		expect(view.render(60)[2]).toBe("Reason");
		view.handleInput("e");
		expect(view.render(60)[0]).toContain("Denied (3)");
		expect(effects).toHaveLength(0);
	});

	it("ignores explain on empty lists and other tabs", () => {
		const { view, menu, ledger, effects } = setup();
		for (const denial of ledger.open()) ledger.dismiss(denial.id);
		view.handleInput("e");
		expect(view.render(80)).toContain("Nothing blocked is waiting.");
		for (const tab of ["granted", "auto", "settings"] as const) {
			menu.tab = tab;
			view.handleInput("e");
			expect(view.render(80)[0]).toContain("Denied (0)");
		}
		expect(effects).toHaveLength(0);
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
		const menu = new PermissionsMenu(new PermissionLedger(), { auto: () => [], settings: () => [] });
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

describe("the menu's settings tabs", () => {
	it("shows auto mode's rows, the highlighted one described, and acts only on what can change", () => {
		const { view, effects } = setup();
		view.handleInput("\t");
		view.handleInput("\t");
		const lines = view.render(80);
		expect(lines.some((l) => l.startsWith("❯ Auto mode") && l.includes("on"))).toBe(true);
		expect(lines).toContain("    Classify calls.");
		view.handleInput("\r");
		expect(effects.at(-1)).toMatchObject({ kind: "act", tab: "auto", row: { id: "toggle" } });
		view.handleInput("j");
		const before = effects.length;
		view.handleInput("\r");
		// A row that only shows a value does nothing.
		expect(effects).toHaveLength(before);
	});

	it("toggles a permission-system setting, and cycles back round to Denied", () => {
		const { view, effects } = setup();
		view.handleInput("\x1b[D");
		expect(view.render(80).some((l) => l.includes("YOLO mode"))).toBe(true);
		view.handleInput(" ");
		expect(effects.at(-1)).toMatchObject({ kind: "act", tab: "settings", row: { id: "yoloMode" } });
		view.handleInput("\t");
		expect(view.render(80).some((l) => l.includes("Write(/etc/hosts)"))).toBe(true);
	});
});

describe("denial summaries and approval keys", () => {
	it("puts the command explanation and denial reason on separate truncated lines", () => {
		const { ledger, view } = setup();
		ledger.record({ toolCallId: "explained", toolName: "bash", input: { command: "git push " + "origin ".repeat(30), description: "Publish these commits. ".repeat(20) + "DESCRIPTION_END" }, reason: "Remote changes need approval. ".repeat(20) + "DENIAL_END" });
		const rows = view.render(80);
		const at = rows.findIndex((row) => row.includes("Bash("));
		expect(rows[at + 1]).toStartWith("     Does: Publish these commits.");
		expect(rows[at + 2]).toStartWith("     Denied: Remote changes need approval.");
		for (const row of rows.slice(at, at + 3)) { expect(visibleWidth(row)).toBeLessThanOrEqual(80); expect(row).toContain("…"); }
		view.handleInput("e");
		let expanded = "";
		for (let i = 0; i < 100; i++) { expanded += view.render(80).join("\n"); view.handleInput("j"); }
		expect(expanded).toContain("DESCRIPTION_END");
		expect(expanded).toContain("DENIAL_END");
	});
	for (const key of ["\r", "a"]) it(`approves the selected denial with ${JSON.stringify(key)}`, () => {
		const { view, effects } = setup();
		view.handleInput(key);
		expect(effects).toMatchObject([{ kind: "approve", denial: { toolCallId: "c2" } }]);
	});
});

for (const key of ["\r", "a"]) it(`approves after expanding with ${JSON.stringify(key)}`, () => {
	const { view, effects } = setup();
	view.handleInput("e"); view.handleInput(key);
	expect(effects).toMatchObject([{ kind: "approve", denial: { toolCallId: "c2" } }]);
});

for (const expanded of [false, true]) it(`capital A approves only the exact call (${expanded ? "expanded" : "list"})`, () => {
	const { view, effects } = setup();
	if (expanded) view.handleInput("e");
	view.handleInput("A");
	expect(effects).toMatchObject([{ kind: "approve-exact", denial: { toolCallId: "c2" } }]);
});

it("capital A does nothing on other tabs or an empty denied list", () => {
	const { view, menu, ledger, effects } = setup();
	for (const denial of ledger.open()) ledger.dismiss(denial.id);
	for (const tab of ["denied", "granted", "auto", "settings"] as const) {
		menu.tab = tab; view.handleInput("A");
	}
	expect(effects).toEqual([]);
});
