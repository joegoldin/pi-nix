// The native session is the durable source of operator decisions. New UI
// answers have their own entry; old sessions retain matched questionnaire
// results. Other tools' output and assistant claims never become authority.

import { z } from "zod";

const questionSchema = z.object({
	question: z.string(),
	options: z.array(z.object({ label: z.string(), description: z.string() })),
});
const answerSchema = z.object({
	questionIndex: z.number().int().nonnegative(),
	question: z.string(),
	kind: z.enum(["option", "custom", "multi"]),
	answer: z.string().nullable().optional(),
	selected: z.array(z.string()).optional(),
	notes: z.string().optional(),
});
const resultSchema = z.object({
	cancelled: z.literal(false),
	error: z.undefined().optional(),
	answers: z.array(answerSchema),
	globalNote: z.string().optional(),
});
const callSchema = z.object({
	type: z.literal("toolCall"), name: z.literal("ask_user_question"), id: z.string(),
	arguments: z.object({ questions: z.array(questionSchema) }),
});
const entrySchema = z.union([
	z.object({ type: z.literal("custom"), customType: z.literal("pi-user-decision"), data: resultSchema.extend({
		version: z.literal(1), source: z.literal("questionnaire"), toolCallId: z.string(), questions: z.array(questionSchema),
	}) }),
	z.object({ type: z.literal("message"), message: z.discriminatedUnion("role", [
		z.object({ role: z.literal("assistant"), content: z.array(z.unknown()) }),
		z.object({ role: z.literal("toolResult"), toolName: z.literal("ask_user_question"), toolCallId: z.string(), isError: z.literal(false).optional(), details: resultSchema }),
	]) }),
]);
type Question = z.infer<typeof questionSchema>;
type Result = z.infer<typeof resultSchema>;

function renderAnswers(questions: Question[], result: Result): string | undefined {
	const answers: string[] = [];
	for (const answer of result.answers) {
		const question = questions[answer.questionIndex];
		if (!question || answer.question !== question.question) continue;
		const selected = answer.kind === "multi" ? answer.selected : answer.answer ? [answer.answer] : [];
		if (!selected?.length || selected.some((value) => !value)) continue;
		if (answer.kind !== "custom" && selected.some((value) => !question.options.some((option) => option.label === value))) continue;
		const descriptions = question.options.filter((option) => selected.includes(option.label)).map((option) => option.description);
		answers.push(JSON.stringify({ question: question.question, answer: selected, selectedDescriptions: descriptions, notes: answer.notes }));
	}
	if (!answers.length) return undefined;
	return `Operator questionnaire response (bounded by its question): ${answers.join("\n")}${result.globalNote ? `\nOperator note: ${result.globalNote}` : ""}`;
}

export interface OperatorDecision {
	index: number;
	text: string;
}

export function operatorDecisions(entries: readonly unknown[]): OperatorDecision[] {
	const calls = new Map<string, Question[]>();
	const decisions = new Map<string, OperatorDecision>();
	for (const [index, raw] of entries.entries()) {
		const parsed = entrySchema.safeParse(raw);
		if (!parsed.success) continue;
		const entry = parsed.data;
		if (entry.type === "custom") {
			const text = renderAnswers(entry.data.questions, entry.data);
			if (text) decisions.set(entry.data.toolCallId, { index, text });
			continue;
		}
		const message = entry.message;
		if (message.role === "assistant") {
			for (const rawCall of message.content) {
				const call = callSchema.safeParse(rawCall);
				if (call.success) calls.set(call.data.id, call.data.arguments.questions);
			}
		} else {
			const questions = calls.get(message.toolCallId);
			if (!questions) continue;
			const text = renderAnswers(questions, message.details);
			if (text) decisions.set(message.toolCallId, { index, text });
		}
	}
	return [...decisions.values()].sort((a, b) => a.index - b.index);
}
