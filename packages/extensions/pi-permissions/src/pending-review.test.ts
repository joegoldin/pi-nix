import { expect, test } from "bun:test";
import { PendingAuthority } from "./engine/authority/pending-authority";
import { PermissionPrompter } from "./engine/authority/permission-prompter";
import { presentInlinePermissionPrompt } from "./engine/authority/permission-prompt-component";
import { composeAuthorizerChain } from "./engine/authority/authorizer-chain";
import { DEFAULT_DIALOG_KEYS } from "./engine/config/dialog-keys";

const payload = {
  kind: "tool", evidence: [], annotations: [],
  request: { requester: { kind: "local", agentName: null }, surface: "tool", toolName: "bash", invokedToolName: null, value: "echo test", matchedPattern: null, matchedCommand: null },
};

test("mode transition closes the real inline prompt and logs approval, never a late denial", async () => {
  let enabled = false;
  let changed = () => {};
  let closed = false;
  let mounted!: () => void;
  const ready = new Promise<void>(resolve => { mounted = resolve; });
  let lateAnswer: (answer: unknown) => void = () => {};
  const entries: string[] = [];
  const authority = new PendingAuthority(() => enabled, listener => { changed = listener; return () => { changed = () => {}; }; });
  const prompter = new PermissionPrompter({ logger: { review: event => entries.push(event) } });
  const ui = {
    custom: factory => new Promise(resolve => {
      const done = value => { closed = true; resolve(value); };
      lateAnswer = done;
      factory({ terminal: { write() {} }, requestRender() {} }, { fg: (_color, text) => text }, { matches: () => false }, done);
      mounted();
    }),
  };
  const answer = prompter.prompt({ authorize: () => authority.run(undefined, true, async signal => ({
    ...await presentInlinePermissionPrompt({
      signal, mode: "tui", ui, doublePressToConfirm: false,
      budget: {}, dialogKeys: DEFAULT_DIALOG_KEYS, promptNotifications: [], notice: { title: "Permission", body: "Review needed" },
    } as never, "Permission", payload as never),
    decidedBy: { kind: "user", via: "dialog" },
  })) }, { requestId: "pending", source: "tool_call", agentName: null, payload } as never);
  await ready;
  enabled = true;
  changed();
  expect((await answer).decidedBy.kind).toBe("yolo");
  expect(closed).toBe(true);
  lateAnswer({ approved: false, state: "denied" });
  await Promise.resolve();
  expect(entries).toEqual(["permission_request.waiting", "permission_request.approved"]);
});

test("a classifier that finishes after cancellation cannot open a terminal prompt", async () => {
  let finish!: (value: { kind: "defer" }) => void;
  const controller = new AbortController();
  let prompts = 0;
  const chain = composeAuthorizerChain([{ name: "classifier", authorize: () => new Promise(resolve => { finish = resolve; }) }], {
    authorize: async () => { prompts++; throw new Error("late prompt"); },
  }, {} as never, { review() {}, debug() {} });
  const result = chain.authorize({ signal: controller.signal } as never);
  controller.abort();
  finish({ kind: "defer" });
  expect((await result).approved).toBe(false);
  expect(prompts).toBe(0);
});
