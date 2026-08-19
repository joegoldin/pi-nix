# Assumption A1: can a pi extension make its own LLM call?

**Answer: yes.** Verified 2026-08-18 against pi 0.84.2.

`ExtensionContext.modelRegistry` is a `ModelRegistry`
(`packages/coding-agent/src/core/extensions/types.ts:319`), whose class
docstring in `packages/coding-agent/src/core/model-registry.ts` reads
"Synchronous compatibility facade exposed to extensions". It exposes:

    complete<TApi extends Api>(
      model: Model<TApi>,
      context: Context,
      options?: ModelsApiStreamOptions<TApi>,
    ): Promise<AssistantMessage>

Four extensions shipped in `packages/coding-agent/examples/extensions/`
already call it: `qna.ts`, `summarize.ts`, `custom-compaction.ts`, and
`handoff.ts`.

Consequence: the design's A1 fallback, shelling out to a small classification
CLI, is not implemented, and should not be added.

`packages/extensions/pi-auto-mode/src/pi-contract.test.ts` re-checks the
docstring, the `complete` signature, and `find(provider, modelId)` against pi's
real source whenever `PI_CODING_AGENT_SRC` is set, which the `pi-auto-mode`
Nix check always does. A pi bump that retires the facade fails there rather
than at load.
