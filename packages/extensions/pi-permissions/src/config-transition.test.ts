import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./engine/config/config-store";
import { PendingAuthority } from "./engine/authority/pending-authority";

test("saving YOLO publishes live mode and settles the current local approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mode-transition-"));
  try {
    const config = new ConfigStore({ agentDir: dir, policyPaths: {} as never, logger: { debug() {}, review() {} } });
    const authority = new PendingAuthority(() => config.current().yoloMode, listener => config.subscribe(listener));
    let signal: AbortSignal | undefined;
    const result = authority.run(undefined, true, async current => {
      signal = current;
      return new Promise(() => {});
    });
    expect(signal?.aborted).toBe(false);
    config.save({ ...config.current(), yoloMode: true }, { ui: { setStatus() {}, notify() {} } } as never);
    expect((await result).decidedBy.kind).toBe("yolo");
    expect(signal?.aborted).toBe(true);
    config.save({ ...config.current(), yoloMode: false }, { ui: { setStatus() {}, notify() {} } } as never);
    expect(config.current().yoloMode).toBe(false);
    const refused = await authority.run(undefined, true, async () => ({ approved: false, state: "denied", decidedBy: { kind: "user", via: "dialog" } }));
    expect(refused.approved).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
