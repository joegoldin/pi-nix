import { describe, expect, it } from "bun:test";
import { formatResult, normalise, type Question, Questionnaire, validate } from "./ask-state.ts";

const q = (question: string, over: Partial<Question> = {}): Question => ({
	question,
	header: question.slice(0, 8),
	options: [
		{ label: "Redis", description: "fast" },
		{ label: "Postgres", description: "durable", preview: "```sql\nSELECT 1\n```" },
	],
	...over,
});

describe("validation", () => {
	it("checks in rpiv's order", () => {
		expect(validate([])?.code).toBe("no_questions");
		expect(validate([q("a"), q("b"), q("c"), q("d"), q("e")])?.code).toBe("too_many_questions");
		expect(validate([q("a"), q("a")])?.code).toBe("duplicate_question");
		expect(validate([q("a", { options: [{ label: "x", description: "" }] })])?.code).toBe("empty_options");
		expect(validate([q("a", { options: [{ label: "Other", description: "" }, { label: "y", description: "" }] })])?.code).toBe("reserved_label");
		expect(validate([q("a", { options: [{ label: "x", description: "" }, { label: "x", description: "" }] })])?.code).toBe("duplicate_option_label");
		expect(validate([q("a")])).toBeUndefined();
	});

	it("normalises line endings in everything the model sent", () => {
		expect(normalise([q("a\r\nb")])[0].question).toBe("a\nb");
	});
});

describe("one single-select question", () => {
	it("finishes on the first choice, with no submit step", () => {
		const s = new Questionnaire([q("Which cache?")]);
		s.confirm();
		expect(s.result?.cancelled).toBe(false);
		expect(formatResult(s.result!)).toBe(
			'User has answered your questions: "Which cache?"="Redis". You can now continue with the user\'s answers in mind.',
		);
	});

	it("carries the preview of the option chosen", () => {
		const s = new Questionnaire([q("Which db?")]);
		s.move(1);
		s.confirm();
		expect(s.result?.answers[0].preview).toContain("SELECT 1");
	});

	it("takes a typed answer from the Type something. row", () => {
		const s = new Questionnaire([q("Which cache?")]);
		s.move(2);
		expect(s.mode).toBe("custom");
		s.drafts.set(0, "memcached");
		s.confirm();
		expect(s.result?.answers[0]).toMatchObject({ kind: "custom", answer: "memcached" });
	});

	it("is a decline when cancelled", () => {
		const s = new Questionnaire([q("Which cache?")]);
		s.finish(true);
		expect(formatResult(s.result!)).toBe("User declined to answer questions");
	});
});

describe("several questions", () => {
	it("advances through them to a submit tab", () => {
		const s = new Questionnaire([q("First?"), q("Second?", { multiSelect: true })]);
		s.confirm();
		expect(s.tab).toBe(1);
		s.toggle();
		s.move(1);
		s.toggle();
		s.move(2);
		expect(s.currentRow()).toBe("Next");
		s.confirm();
		expect(s.onSubmitTab).toBe(true);
		s.confirm();
		expect(formatResult(s.result!)).toBe(
			'User has answered your questions: "First?"="Redis". "Second?"="Redis, Postgres". You can now continue with the user\'s answers in mind.',
		);
	});

	it("names what is still unanswered on the submit tab", () => {
		const s = new Questionnaire([q("First?"), q("Second?")]);
		s.switchTab(-1);
		expect(s.onSubmitTab).toBe(true);
		expect(s.unanswered()).toEqual(["First?", "Second?"]);
	});

	it("keeps notes, per question and overall", () => {
		const s = new Questionnaire([q("First?"), q("Second?")]);
		s.saveNote("keep it simple");
		s.confirm();
		s.confirm();
		s.saveNote("ship today");
		s.confirm();
		const text = formatResult(s.result!);
		expect(text).toContain('"First?"="Redis". user notes: keep it simple.');
		expect(text).toContain("global note: ship today.");
	});
});

describe("the answer text", () => {
	it("marks an empty answer as no input", () => {
		expect(
			formatResult({ cancelled: false, answers: [{ questionIndex: 0, question: "Q?", kind: "custom", answer: null }] }),
		).toContain('"Q?"="(no input)"');
	});
});
