import type { PermissionPromptDecision } from "./permission-dialog";

export const AUTHORITY_CANCELLED = Symbol("permission-authority-cancelled");

/** Owns cancellation for asks already in the authorizer chain. */
export class PendingAuthority {
  private readonly outstanding = new Set<(reason?: string) => void>();

  constructor(
    private readonly isYoloEnabled: () => boolean,
    private readonly subscribe: (listener: () => void) => () => void,
  ) {}

  run(signal: AbortSignal | undefined, local: boolean, authorize: (signal: AbortSignal) => Promise<PermissionPromptDecision>): Promise<PermissionPromptDecision> {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        this.outstanding.delete(cancel);
      };
      const finish = (decision: PermissionPromptDecision, abort = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        // Settle authority before aborting the UI/classifier: their late answer
        // must not replace the mode transition that cancelled them.
        if (abort) controller.abort(AUTHORITY_CANCELLED);
        resolve(decision);
      };
      const cancel = (reason = "Permission request cancelled or session changed") => finish({
        approved: false, state: "denied", confirmationUnavailable: true,
        denialReason: reason,
        decidedBy: { kind: "unavailable", reason },
      }, true);
      const onAbort = () => cancel();
      const changed = () => {
        if (signal?.aborted) cancel();
        else if (local && this.isYoloEnabled()) finish({
          approved: true, state: "approved", decidedBy: { kind: "yolo", pattern: null },
        }, true);
      };
      this.outstanding.add(cancel);
      signal?.addEventListener("abort", onAbort, { once: true });
      unsubscribe = this.subscribe(changed);
      changed();
      if (settled) return;
      try {
        void authorize(controller.signal).then(decision => finish(decision), error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
  }

  cancel(): void {
    for (const cancel of [...this.outstanding]) cancel("The session ended before this permission request was answered.");
  }
}
