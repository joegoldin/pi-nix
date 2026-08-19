// Fake OpenAI-compatible provider. One endpoint serves two roles, told apart by
// the system prompt: pi-automode's classifier prompt names its own rule
// sections verbatim, and the session prompt never does. Every request body is
// written to requests.jsonl before a reply is chosen, so "was the classifier
// consulted" is observed rather than inferred.
const DIR = process.env.E2E_DIR!;
const CASE = JSON.parse(await Bun.file(`${DIR}/case.json`).text());
import { appendFileSync } from "node:fs";
const log = (obj: unknown) =>
  appendFileSync(`${DIR}/requests.jsonl`, JSON.stringify(obj) + "\n");

function isClassifier(body: any): boolean {
  const sys = (body.messages ?? [])
    .filter((m: any) => m.role === "system" || m.role === "developer")
    .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  // The classifier's system prompt opens with this sentence and pi's session
  // prompt never contains it. Matching auto-mode words alone would misfire:
  // the extension appends its own guidance to the SESSION prompt too.
  return sys.includes("You are an auto-mode security classifier");
}

function sse(chunks: any[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

const base = (model: string) => ({
  id: "chatcmpl-e2e",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model,
});

function textReply(model: string, text: string) {
  return sse([
    { ...base(model), choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...base(model), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...base(model), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
}

function toolReply(model: string, name: string, args: Record<string, unknown>) {
  return sse([
    {
      ...base(model),
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call_e2e_1",
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: null,
      }],
    },
    { ...base(model), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { ...base(model), choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
  ]);
}

let sessionTurn = 0;

Bun.serve({
  port: Number(process.env.E2E_PORT ?? 8231),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const body: any = await req.json().catch(() => ({}));
    // Readiness probe from the runner, not a model call.
    if (!body.messages) return new Response("ok");
    const role = isClassifier(body) ? "CLASSIFIER" : "SESSION";
    log({ ts: Date.now(), path: url.pathname, role, model: body.model, body });

    if (role === "CLASSIFIER") {
      if (CASE.classifier === "error") {
        return new Response(JSON.stringify({ error: { message: "e2e injected provider error" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      // The fast stage asks for one token, 0 (clearly allowed) or 1 (review).
      // Anything the case wants to test about the verdict belongs to the
      // detailed stage, so the fast stage always asks for review.
      const isFast = JSON.stringify(body).includes("Return exactly one digit and nothing else");
      if (isFast) return textReply(body.model, "1");
      return textReply(body.model, CASE.classifier);
    }

    sessionTurn += 1;
    // First turn emits the tool call under test; every turn after it is plain
    // text, so a blocked tool cannot drive a loop.
    if (sessionTurn === 1) return toolReply(body.model, CASE.tool, CASE.input);
    return textReply(body.model, "done");
  },
});
console.log("e2e provider listening");
