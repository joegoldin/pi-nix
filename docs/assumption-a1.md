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

The differential test that re-checked the docstring, the `complete` signature,
and `find(provider, modelId)` against pi's source lived in the first-party
auto-mode extension, and went with it. `@czottmann/pi-automode` calls the same
facade (`extensions/auto-mode/classifier.ts`) and its own suite covers it, but
that suite runs upstream, not here. A pi bump that retires the facade now
surfaces as a failed classifier call, which fails closed.
