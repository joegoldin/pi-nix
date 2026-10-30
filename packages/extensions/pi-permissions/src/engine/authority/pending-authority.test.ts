import { expect, test } from "bun:test";
import { PendingAuthority } from "./pending-authority";

function host() {
  let enabled = false;
  const listeners = new Set<() => void>();
  const pending = new PendingAuthority(() => enabled, listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  return { pending, listeners, toggle(value: boolean) { enabled = value; for (const listener of listeners) listener(); } };
}
const denied = { approved: false, state: "denied" as const, decidedBy: { kind: "user" as const, via: "dialog" as const } };

test("enabling YOLO cancels a pending authorizer and ignores its late denial", async () => {
  const h = host();
  let signal: AbortSignal | undefined;
  let finish!: (value: typeof denied) => void;
  const answer = h.pending.run(undefined, true, current => {
    signal = current;
    return new Promise(resolve => { finish = resolve; });
  });
  expect(signal?.aborted).toBe(false);
  h.toggle(true);
  expect(signal?.aborted).toBe(true);
  expect((await answer).decidedBy.kind).toBe("yolo");
  finish(denied);
  expect(h.listeners.size).toBe(0);
  h.toggle(false);
  expect(await h.pending.run(undefined, true, async () => denied)).toEqual(denied);
});

test("YOLO grants new local asks without starting classification or UI", async () => {
  const h = host();
  h.toggle(true);
  expect((await h.pending.run(undefined, true, async () => { throw new Error("must not prompt"); })).approved).toBe(true);
});

test("cancellation, session teardown and child-owned asks never acquire YOLO authority", async () => {
  const h = host();
  const controller = new AbortController();
  const cancelled = h.pending.run(controller.signal, true, async () => new Promise(() => {}));
  controller.abort();
  h.toggle(true);
  expect((await cancelled).approved).toBe(false);
  expect(await h.pending.run(undefined, false, async () => denied)).toEqual(denied);
  h.toggle(false);
  const stale = h.pending.run(undefined, true, async () => new Promise(() => {}));
  h.pending.cancel();
  h.toggle(true);
  expect((await stale).approved).toBe(false);
  expect(h.listeners.size).toBe(0);
});
