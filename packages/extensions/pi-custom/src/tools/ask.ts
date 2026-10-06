// ask_user_question: structured questions the model can put to you mid-task.
//
// In the terminal it is a questionnaire drawn in the editor's place: one tab
// per question when there are several, options with descriptions, a
// "Type something." row for your own answer, checkboxes for multi-select,
// notes on n, and a submit tab. RPC clients get the same questions as a
// series of select and input dialogs. Print and JSON modes have no one to
// ask, so the tool says so instead of guessing.

import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatResult, NEXT_ROW, normalise, type Question, Questionnaire, type Result, TYPE_ROW, validate } from "./ask-state.ts";
import type { UiTheme } from "../ui/card.ts";
import { Framed } from "../ui/frame.ts";

const DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

const GUIDELINES = [
	"Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to 4 questions per invocation.",
	'Each question MUST have 2-4 options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.',
	'Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.',
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

const SIDE_BY_SIDE_MIN = 100;

/** The questionnaire as a component: renders from the state, routes keys into it. */
class QuestionnaireView {
	private input = new Input();

	constructor(
		private q: Questionnaire,
		private theme: UiTheme & { bg?(slot: string, text: string): string },
		private done: () => void,
	) {
		this.syncInput();
	}

	private syncInput(): void {
		const key = this.q.onSubmitTab ? this.q.questions.length : this.q.tab;
		this.input.setValue(this.q.mode === "notes" ? (this.q.notes.get(key) ?? "") : (this.q.drafts.get(this.q.tab) ?? ""));
		this.input.focused = this.q.mode !== "nav";
	}

	handleInput(data: string): void {
		const q = this.q;
		if (q.mode === "notes") {
			if (matchesKey(data, "escape")) q.mode = "nav";
			else if (matchesKey(data, "enter")) q.saveNote(this.input.getValue());
			else this.input.handleInput(data);
			this.syncInput();
			return;
		}
		if (q.mode === "custom") {
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				q.drafts.set(q.tab, this.input.getValue());
				q.move(matchesKey(data, "up") ? -1 : 1);
			} else if (matchesKey(data, "escape")) {
				q.finish(true);
			} else if (matchesKey(data, "enter")) {
				q.drafts.set(q.tab, this.input.getValue());
				q.confirm();
			} else {
				this.input.handleInput(data);
				q.drafts.set(q.tab, this.input.getValue());
				return;
			}
			this.syncInput();
			if (q.result) this.done();
			return;
		}
		if (matchesKey(data, "escape")) q.finish(true);
		else if (matchesKey(data, "up")) q.move(-1);
		else if (matchesKey(data, "down")) q.move(1);
		else if (matchesKey(data, "tab") || matchesKey(data, "right")) q.switchTab(1);
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) q.switchTab(-1);
		else if (data === " ") q.toggle();
		else if (data === "n") q.mode = "notes";
		else if (matchesKey(data, "enter")) q.confirm();
		this.syncInput();
		if (q.result) this.done();
	}

	private tabs(): string {
		const { theme, q } = this;
		if (!q.multipleQuestions) return "";
		const chip = (text: string, active: boolean, ok: boolean) =>
			active && theme.bg ? theme.bg("selectedBg", ` ${text} `) : theme.fg(ok ? "success" : "muted", ` ${text} `);
		const parts = q.questions.map((question, i) => chip(`${q.answers.has(i) ? "■" : "□"} ${question.header}`, i === q.tab, q.answers.has(i)));
		parts.push(chip("✓ Submit", q.onSubmitTab, q.unanswered().length === 0));
		return `${theme.fg("dim", " ← ")}${parts.join("")}${theme.fg("dim", " →")}`;
	}

	private optionRows(width: number): string[] {
		const { theme, q } = this;
		const question = q.question!;
		const checked = q.checked.get(q.tab) ?? new Set<string>();
		const answered = q.answers.get(q.tab);
		const rows: string[] = [];
		q.rows().forEach((label, i) => {
			const here = i === q.cursor;
			const pointer = here ? theme.fg("accent", "❯ ") : "  ";
			if (label === TYPE_ROW) {
				const n = `${i + 1}. `;
				if (q.mode === "custom") {
					const field = this.input.render(Math.max(10, width - visibleWidth(pointer + n)))[0] ?? "";
					rows.push(`${pointer}${n}${field}`);
				} else {
					const draft = q.drafts.get(q.tab);
					rows.push(`${pointer}${n}${here ? theme.bold(label) : label}${draft ? theme.fg("muted", ` ${draft}`) : ""}`);
				}
				return;
			}
			if (label === NEXT_ROW) {
				rows.push(`${pointer}${here ? theme.bold(label) : theme.fg("muted", label)}`);
				return;
			}
			const option = question.options[i];
			const box = question.multiSelect ? (checked.has(label) ? theme.fg("accent", "[✔] ") : theme.fg("muted", "[ ] ")) : "";
			const mark = answered?.kind === "option" && answered.answer === label ? theme.fg("success", " ✔") : "";
			rows.push(`${pointer}${box}${i + 1}. ${here ? theme.bold(label) : label}${mark}`);
			for (const line of wrapTextWithAnsi(option.description, Math.max(10, width - 5))) rows.push(`     ${theme.fg("muted", line)}`);
		});
		return rows;
	}

	private questionBody(width: number): string[] {
		const { theme, q } = this;
		const question = q.question!;
		const out: string[] = [];
		const badge = !q.multipleQuestions && theme.bg ? `${theme.bg("selectedBg", ` ${question.header} `)} ` : "";
		out.push(...wrapTextWithAnsi(`${badge}${theme.bold(question.question)}`, width), "");
		const focused = question.options[q.cursor];
		const preview = !question.multiSelect && question.options.some((o) => o.preview) ? focused?.preview : undefined;
		if (preview !== undefined && width >= SIDE_BY_SIDE_MIN) {
			const leftW = Math.floor(width * 0.45);
			const rightW = width - leftW - 3;
			const left = this.optionRows(leftW);
			const right = new Markdown(preview, 0, 0, getMarkdownTheme()).render(rightW);
			for (let i = 0; i < Math.max(left.length, right.length); i++) {
				const l = left[i] ?? "";
				out.push(`${truncateToWidth(l, leftW)}${" ".repeat(Math.max(0, leftW - visibleWidth(l)))} ${theme.fg("dim", "│")} ${right[i] ?? ""}`);
			}
		} else {
			out.push(...this.optionRows(width));
			if (preview !== undefined) out.push("", ...new Markdown(preview, 0, 0, getMarkdownTheme()).render(width));
		}
		const note = q.notes.get(q.tab);
		if (q.mode === "notes") out.push("", `${theme.fg("muted", "notes: ")}${this.input.render(Math.max(10, width - 7))[0] ?? ""}`);
		else if (note) out.push("", theme.fg("dim", `notes: ${note}`));
		return out;
	}

	private submitBody(width: number): string[] {
		const { theme, q } = this;
		const out = [theme.bold(theme.fg("accent", "Review your answers")), ""];
		q.questions.forEach((question, i) => {
			const a = q.answers.get(i);
			if (!a) return;
			const v = a.kind === "multi" ? (a.selected ?? []).join(", ") : (a.answer ?? "(no input)");
			out.push(theme.fg("muted", ` ● ${question.header || `Q${i + 1}`}`), `   → ${v}`);
			if (a.notes) out.push(theme.fg("dim", `     notes: ${a.notes}`));
		});
		const global = q.notes.get(q.questions.length);
		if (q.mode === "notes") out.push("", `${theme.fg("muted", "note: ")}${this.input.render(Math.max(10, width - 6))[0] ?? ""}`);
		else if (global) out.push("", theme.fg("dim", `Note: ${global}`));
		const missing = q.unanswered();
		out.push("", missing.length ? theme.fg("warning", `⚠ Answer remaining questions before submitting: ${missing.join(", ")}`) : "Ready to submit your answers?");
		out.push(
			`${q.submitCursor === 0 ? theme.fg("accent", "❯ ") : "  "}Submit answers`,
			`${q.submitCursor === 1 ? theme.fg("accent", "❯ ") : "  "}Cancel`,
		);
		return out;
	}

	private hints(): string {
		const q = this.q;
		const parts = q.onSubmitTab
			? ["Enter to select", "↑/↓ to navigate", "n to add a note", "Tab to switch questions", "Esc to cancel"]
			: [
					"Enter to select",
					"↑/↓ to navigate",
					...(q.question?.multiSelect ? ["Space to toggle"] : []),
					...(q.mode === "nav" ? ["n to add notes"] : []),
					...(q.multipleQuestions ? ["Tab to switch questions"] : []),
					"Esc to cancel",
				];
		return this.theme.fg("dim", parts.join(" · "));
	}

	render(width: number): string[] {
		const tabs = this.tabs();
		const body = this.q.onSubmitTab ? this.submitBody(width) : this.questionBody(width);
		return [...(tabs ? [tabs, ""] : []), ...body, "", this.hints()].map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l));
	}

	invalidate(): void {}
}

/** RPC clients: the same questions, one select or input dialog at a time. */
async function askByDialogs(questions: Question[], ui: ExtensionContext["ui"]): Promise<Result> {
	const q = new Questionnaire(questions);
	for (const [i, question] of questions.entries()) {
		const title = `[${question.header}] ${question.question}${question.options
			.filter((o) => o.preview)
			.map((o, n) => `\n--- ${n + 1}. ${o.label} preview ---\n${o.preview!.slice(0, 600)}`)
			.join("")}`;
		if (question.multiSelect) {
			const list = question.options.map((o, n) => `${n + 1}. ${o.label} — ${o.description}`).join("\n");
			const raw = await ui.input(
				`${title}\n\n${list}\n\nEnter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.`,
				"1,3",
			);
			if (raw === undefined) return { answers: [...q.answers.values()], cancelled: true };
			const text = raw.trim();
			const nums = text.split(",").map((s) => Number(s.trim()));
			if (text === "" || nums.every((n) => Number.isInteger(n) && n >= 1 && n <= question.options.length)) {
				const selected = text === "" ? [] : [...new Set(nums)].map((n) => question.options[n - 1].label);
				q.answers.set(i, { questionIndex: i, question: question.question, kind: "multi", answer: null, selected });
			} else {
				q.answers.set(i, { questionIndex: i, question: question.question, kind: "custom", answer: text });
			}
			continue;
		}
		const choices = [...question.options.map((o, n) => `${n + 1}. ${o.label} — ${o.description}`), `${question.options.length + 1}. ${TYPE_ROW}`];
		const picked = await ui.select(title, choices);
		const index = picked === undefined ? -1 : choices.indexOf(picked);
		if (index < 0) return { answers: [...q.answers.values()], cancelled: true };
		if (index === question.options.length) {
			const text = await ui.input(`${title}\n\nType your answer:`, "");
			if (text === undefined) return { answers: [...q.answers.values()], cancelled: true };
			q.answers.set(i, { questionIndex: i, question: question.question, kind: "custom", answer: text.trim() || null });
		} else {
			const o = question.options[index];
			q.answers.set(i, { questionIndex: i, question: question.question, kind: "option", answer: o.label, ...(o.preview ? { preview: o.preview } : {}) });
		}
	}
	q.finish(false);
	return q.result!;
}

export function registerAsk(pi: ExtensionAPI): void {
	// With no one to ask, the tool would only cost tokens and a failed call.
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user_question"));
	});

	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: DESCRIPTION,
		promptSnippet: "Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({
						description:
							'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
					}),
					header: Type.String({
						maxLength: 16,
						description:
							'MAX 16 CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".',
					}),
					options: Type.Array(
						Type.Object({
							label: Type.String({
								maxLength: 60,
								description:
									"MAX 60 CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
							}),
							description: Type.String({
								description:
									"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
							}),
							preview: Type.Optional(
								Type.String({
									description:
										"Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
								}),
							),
						}),
						{
							minItems: 2,
							maxItems: 4,
							description:
								"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
						},
					),
					multiSelect: Type.Optional(
						Type.Boolean({
							default: false,
							description:
								"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
						}),
					),
				}),
				{ minItems: 1, maxItems: 4, description: "Questions to ask the user (1-4 questions)" },
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const questions = normalise(params.questions as Question[]);
			const reply = (result: Result) => ({ content: [{ type: "text" as const, text: formatResult(result) }], details: result });
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text" as const, text: "Error: UI not available (running in non-interactive mode)" }],
					details: { answers: [], cancelled: true, error: "no_ui" },
				};
			}
			const problem = validate(questions);
			if (problem) {
				return { content: [{ type: "text" as const, text: `Error: ${problem.message}` }], details: { answers: [], cancelled: true, error: problem.code } };
			}
			// A terminal bell, so a question asked while you look away still finds you.
			if (process.stdout.isTTY) process.stdout.write("\x07");
			if (ctx.mode !== "tui") return reply(await askByDialogs(questions, ctx.ui));
			const q = new Questionnaire(questions);
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const view = new QuestionnaireView(q, theme as never, () => done());
				const framed = new Framed(view, "Question", theme as never);
				return {
					render: (w: number) => framed.render(w),
					invalidate: () => framed.invalidate(),
					handleInput: (data: string) => {
						framed.handleInput(data);
						tui.requestRender();
					},
				};
			});
			return reply(q.result ?? { answers: [...q.answers.values()], cancelled: true });
		},
	});
}
