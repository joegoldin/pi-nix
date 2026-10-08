/**
 * Claude Code-style auto mode for Pi.
 *
 * The enforcement order is deliberately different from simple "auto reviewer" plugins:
 * permission deny/ask rules and deterministic hard-deny checks run before any fast-path allow.
 * Only read-only built-in tools bypass classification; every side-effecting action goes through the classifier.
 */

export * from "./classifier.ts";
export * from "./bash.ts";
export * from "./config.ts";
export * from "./constants.ts";
export * from "./extension.ts";
export * from "./hard-deny.ts";
export * from "./log.ts";
export * from "./model.ts";
export * from "./model-selector.ts";
export * from "./paths.ts";
export * from "./permission-chain.ts";
export * from "./permissions.ts";
export * from "./state.ts";
export * from "./transcript.ts";
export * from "./types.ts";

import { createPiAutomode } from "./extension.ts";
import { withPermissionChain } from "./permission-chain.ts";

// Fork-only: lets auto mode run beside @gotgenes/pi-permission-system as a
// registered link on its authorizer chain, and stay upstream's own gate when
// that package is not installed. See auto-mode/permission-chain.ts.
export default withPermissionChain(createPiAutomode());
