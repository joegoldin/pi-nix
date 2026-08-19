import { describe, expect, it } from "bun:test";
import { MAX_HISTORY, UndoBuffer } from "./undo.ts";

describe("UndoBuffer", () => {
	it("returns nothing to undo when nothing was recorded", () => {
		expect(new UndoBuffer().undo("current")).toBeUndefined();
	});

	it("undoes to the recorded text", () => {
		const buffer = new UndoBuffer();
		buffer.record("before");
		expect(buffer.undo("after")).toBe("before");
	});

	it("walks back through several edits", () => {
		const buffer = new UndoBuffer();
		buffer.record("one");
		buffer.record("two");
		expect(buffer.undo("three")).toBe("two");
		expect(buffer.undo("two")).toBe("one");
		expect(buffer.undo("one")).toBeUndefined();
	});

	it("redoes what it undid", () => {
		const buffer = new UndoBuffer();
		buffer.record("before");
		expect(buffer.undo("after")).toBe("before");
		expect(buffer.redo("before")).toBe("after");
	});

	it("has nothing to redo before an undo", () => {
		const buffer = new UndoBuffer();
		buffer.record("before");
		expect(buffer.redo("after")).toBeUndefined();
	});

	// The standard rule: editing after an undo abandons the branch that was
	// redoable, because it can no longer be reached from here.
	it("drops the redo stack on a fresh edit", () => {
		const buffer = new UndoBuffer();
		buffer.record("one");
		buffer.undo("two");
		buffer.record("three");
		expect(buffer.redo("three")).toBeUndefined();
	});

	it("ignores a record that changes nothing", () => {
		const buffer = new UndoBuffer();
		buffer.record("same");
		buffer.record("same");
		expect(buffer.undo("same")).toBe("same");
		expect(buffer.undo("same")).toBeUndefined();
	});

	it("caps the history, dropping the oldest", () => {
		const buffer = new UndoBuffer();
		for (let i = 0; i <= MAX_HISTORY; i++) buffer.record(`edit ${i}`);
		let steps = 0;
		let current = "now";
		for (;;) {
			const previous = buffer.undo(current);
			if (previous === undefined) break;
			current = previous;
			steps++;
		}
		expect(steps).toBe(MAX_HISTORY);
		expect(current).toBe("edit 1");
	});
});
