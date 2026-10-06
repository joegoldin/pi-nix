// ask_user_question's questionnaire: validation, the state a person moves
// through, and the text the model gets back. Pure, so the whole interaction
// is testable as a sequence of keys.
//
// Validation messages and the result text follow rpiv-ask-user-question.

export interface Option {
	label: string;
	description: string;
	preview?: string;
}

export interface Question {
	question: string;
	header: string;
	options: Option[];
	multiSelect?: boolean;
}

export interface Answer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

export interface Result {
	answers: Answer[];
	cancelled: boolean;
	globalNote?: string;
	error?: string;
}

const RESERVED = new Set(["other", "type something.", "next"]);
export const TYPE_ROW = "Type something.";
export const NEXT_ROW = "Next";

/** The first problem with a questionnaire, in rpiv's order, or undefined. */
export function validate(questions: Question[]): { code: string; message: string } | undefined {
	if (questions.length === 0) return { code: "no_questions", message: "At least one question is required" };
	if (questions.length > 4) return { code: "too_many_questions", message: "At most 4 questions are allowed per invocation" };
	if (new Set(questions.map((q) => q.question)).size !== questions.length) {
		return { code: "duplicate_question", message: "Question text must be unique within an invocation" };
	}
	for (const q of questions) {
		if (q.options.length < 2) return { code: "empty_options", message: "Each question requires at least 2 options" };
	}
	for (const q of questions) {
		if (q.options.some((o) => RESERVED.has(o.label.trim().toLowerCase()))) {
			return { code: "reserved_label", message: "Option label is reserved (Other, Type something., Next)" };
		}
	}
	for (const q of questions) {
		if (new Set(q.options.map((o) => o.label)).size !== q.options.length) {
			return { code: "duplicate_option_label", message: "Option labels must be unique within a question" };
		}
	}
	return undefined;
}

/** Line endings normalised in every string the model sent. */
export function normalise(questions: Question[]): Question[] {
	const n = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "");
	return questions.map((q) => ({
		...q,
		question: n(q.question),
		header: n(q.header),
		options: q.options.map((o) => ({ label: n(o.label), description: n(o.description), ...(o.preview !== undefined ? { preview: n(o.preview) } : {}) })),
	}));
}

function value(a: Answer): string {
	const v = a.kind === "multi" ? (a.selected ?? []).join(", ") : (a.answer ?? "");
	return v === "" ? "(no input)" : v;
}

export function formatResult(r: Result): string {
	if (r.cancelled || (r.answers.length === 0 && !r.globalNote)) return "User declined to answer questions";
	const segments = r.answers.map((a) => {
		let s = `"${a.question}"="${value(a)}"`;
		if (a.preview) s += `. selected preview: ${a.preview}`;
		if (a.notes) s += `. user notes: ${a.notes}`;
		return `${s}.`;
	});
	if (r.globalNote) segments.push(`global note: ${r.globalNote}.`);
	return `User has answered your questions: ${segments.join(" ")} You can now continue with the user's answers in mind.`;
}

export type Mode = "nav" | "custom" | "notes";

/** Where the person is and what they have chosen so far. */
export class Questionnaire {
	tab = 0;
	cursor = 0;
	mode: Mode = "nav";
	submitCursor = 0;
	readonly answers = new Map<number, Answer>();
	readonly checked = new Map<number, Set<string>>();
	readonly notes = new Map<number, string>();
	readonly drafts = new Map<number, string>();
	result: Result | undefined;

	constructor(readonly questions: Question[]) {}

	get multipleQuestions(): boolean {
		return this.questions.length > 1;
	}

	/** The submit tab sits after the questions, and only when there is more than one. */
	get onSubmitTab(): boolean {
		return this.multipleQuestions && this.tab === this.questions.length;
	}

	get question(): Question | undefined {
		return this.questions[this.tab];
	}

	rows(): string[] {
		const q = this.question;
		if (!q) return [];
		return [...q.options.map((o) => o.label), TYPE_ROW, ...(q.multiSelect ? [NEXT_ROW] : [])];
	}

	currentRow(): string | undefined {
		return this.rows()[this.cursor];
	}

	move(delta: number): void {
		if (this.onSubmitTab) {
			this.submitCursor = (this.submitCursor + delta + 2) % 2;
			return;
		}
		const n = this.rows().length;
		this.cursor = (this.cursor + delta + n) % n;
		this.mode = this.currentRow() === TYPE_ROW ? "custom" : "nav";
	}

	switchTab(delta: number): void {
		if (!this.multipleQuestions) return;
		const n = this.questions.length + 1;
		this.tab = (this.tab + delta + n) % n;
		this.cursor = 0;
		this.mode = "nav";
	}

	private record(answer: Answer): void {
		const notes = this.notes.get(this.tab);
		this.answers.set(this.tab, notes ? { ...answer, notes } : answer);
	}

	/** After an answer: the next question, the submit tab, or done when there was only one. */
	private advance(): void {
		if (!this.multipleQuestions) {
			this.finish(false);
			return;
		}
		this.tab = Math.min(this.tab + 1, this.questions.length);
		this.cursor = 0;
		this.mode = "nav";
	}

	toggle(): void {
		const q = this.question;
		const row = this.currentRow();
		if (!q?.multiSelect || !row || row === TYPE_ROW || row === NEXT_ROW) return;
		const set = this.checked.get(this.tab) ?? new Set<string>();
		if (set.has(row)) set.delete(row);
		else set.add(row);
		this.checked.set(this.tab, set);
		const selected = q.options.map((o) => o.label).filter((l) => set.has(l));
		if (selected.length) this.record({ questionIndex: this.tab, question: q.question, kind: "multi", answer: null, selected });
		else this.answers.delete(this.tab);
	}

	confirm(): void {
		if (this.onSubmitTab) {
			this.finish(this.submitCursor === 1);
			return;
		}
		const q = this.question;
		const row = this.currentRow();
		if (!q || !row) return;
		if (row === TYPE_ROW) {
			const text = (this.drafts.get(this.tab) ?? "").trim();
			if (q.multiSelect) this.checked.delete(this.tab);
			this.record({ questionIndex: this.tab, question: q.question, kind: "custom", answer: text || null });
			this.advance();
			return;
		}
		if (q.multiSelect) {
			if (row !== NEXT_ROW) {
				this.toggle();
				return;
			}
			const set = this.checked.get(this.tab) ?? new Set<string>();
			const selected = q.options.map((o) => o.label).filter((l) => set.has(l));
			this.record({ questionIndex: this.tab, question: q.question, kind: "multi", answer: null, selected });
			this.advance();
			return;
		}
		const option = q.options.find((o) => o.label === row);
		this.record({
			questionIndex: this.tab,
			question: q.question,
			kind: "option",
			answer: row,
			...(option?.preview ? { preview: option.preview } : {}),
		});
		this.advance();
	}

	/** Save the note being edited for this question, or the global one on the submit tab. */
	saveNote(text: string): void {
		const key = this.onSubmitTab ? this.questions.length : this.tab;
		if (text.trim()) this.notes.set(key, text.trim());
		else this.notes.delete(key);
		const existing = this.answers.get(key);
		if (existing) this.answers.set(key, { ...existing, notes: this.notes.get(key) });
		this.mode = "nav";
	}

	finish(cancelled: boolean): void {
		const answers = [...this.answers.values()].sort((a, b) => a.questionIndex - b.questionIndex);
		const globalNote = this.notes.get(this.questions.length);
		this.result = { answers, cancelled, ...(globalNote ? { globalNote } : {}) };
	}

	unanswered(): string[] {
		return this.questions.map((q, i) => (this.answers.has(i) ? "" : q.header || `Q${i + 1}`)).filter(Boolean);
	}
}
