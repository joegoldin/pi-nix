{ lib }:
# Post-build patches to pi, separate from the source patch applied in flake.nix.
# Each uses --replace-fail, so a change upstream breaks the build rather than
# silently dropping the patch.
#
# titleOnlyThinking: some OpenAI models, GPT-6 among them, return reasoning
# summaries that are nothing but bold step titles ("**Checking config**"); the
# reasoning itself stays encrypted, and asking for "detailed" summaries makes
# no difference. pi still treats such a block as collapsible: hidden it reads
# "Thinking...", and a click only swaps that for the title. A thinking run made
# only of titles is now shown as its titles, one `∴ Title` line each with no
# blank line between, as pi-custom draws them in a tool run, and offers no
# click; thinking with real content keeps pi's markdown and toggle.
#
# extensionHidesThinking: pi draws a message's thinking inside its own
# assistant message, where no extension can reach it. pi-custom folds runs of
# exploratory tool calls into one line, and the thinking that led to them
# belongs in that run, not left between the line and the prose after it. pi
# now asks a function an extension may set on globalThis under
# Symbol.for("pi-custom.hideThinking"), called with the assistant message. It
# answers true to leave out every thinking block, shown or "Thinking...", or a
# list of content indices to leave out just those: one message can hold
# thinking that led into a run and thinking that led to a call drawn on its
# own. pi lays a message out when it changes, not when it paints, and the
# answer can change in between (a call joins a run), so each paint asks again
# and lays the message out anew when the answer has changed. Rewriting the
# stored message instead was ruled out: it is what the model is sent back.
let
  file = "lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js";
in
package:
package.overrideAttrs (old: {
  postInstall = (old.postInstall or "") + ''
    substituteInPlace "$out/${file}" --replace-fail \
      ${lib.escapeShellArg "const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;"} \
      ${lib.escapeShellArg ''
        // pi-nix: nothing but bold titles has nothing more to show (pi-patches.nix).
                        const titlesOnly = thinkingBlocks.every((block) => block.split("\n").every((line) => !line.trim() || /^\*\*[^*]+\*\*$/.test(line.trim())));
                        const hidden = !titlesOnly && (this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock);''}
    substituteInPlace "$out/${file}" --replace-fail \
      ${lib.escapeShellArg "this.contentContainer.addChild(new MouseRegion(thinkingComponent, (event) => {"} \
      ${lib.escapeShellArg "this.contentContainer.addChild(titlesOnly ? thinkingComponent : new MouseRegion(thinkingComponent, (event) => {"}
    substituteInPlace "$out/${file}" --replace-fail \
      ${lib.escapeShellArg ": new Markdown(thinkingBlocks.join(\"\\n\\n\"), this.outputPad, 0, this.markdownTheme, {"} \
      ${lib.escapeShellArg ''
        : titlesOnly
                        ? new Text(thinkingBlocks.flatMap((block) => block.split("\n")).map((line) => line.trim().replace(/^\*\*([^*]+)\*\*$/, "$1")).filter(Boolean).map((line) => theme.italic(theme.fg("thinkingText", `∴ ''${line}`))).join("\n"), this.outputPad, 0)
                        : new Markdown(thinkingBlocks.join("\n\n"), this.outputPad, 0, this.markdownTheme, {''}
    substituteInPlace "$out/${file}" --replace-fail \
      ${lib.escapeShellArg "this.contentContainer.clear();"} \
      ${lib.escapeShellArg ''
        this.contentContainer.clear();
                // pi-nix: an extension may draw some or all of this message's thinking itself (pi-patches.nix).
                const hiddenThinking = globalThis[Symbol.for("pi-custom.hideThinking")]?.(message);
                this.thinkingHiddenByExtension = hiddenThinking === true ? "all" : Array.isArray(hiddenThinking) ? hiddenThinking.join(",") : "";
                if (hiddenThinking === true) {
                    message = { ...message, content: message.content.filter((c) => c.type !== "thinking") };
                } else if (Array.isArray(hiddenThinking) && hiddenThinking.length > 0) {
                    const hide = new Set(hiddenThinking);
                    message = { ...message, content: message.content.filter((c, i) => c.type !== "thinking" || !hide.has(i)) };
                }''}
    substituteInPlace "$out/${file}" --replace-fail \
      ${lib.escapeShellArg "const lines = super.render(width);"} \
      ${lib.escapeShellArg ''
        // pi-nix: the extension's answer can change after layout, as when a call joins a run (pi-patches.nix).
                if (this.lastMessage) {
                    const hiddenThinking = globalThis[Symbol.for("pi-custom.hideThinking")]?.(this.lastMessage);
                    const key = hiddenThinking === true ? "all" : Array.isArray(hiddenThinking) ? hiddenThinking.join(",") : "";
                    if (key !== (this.thinkingHiddenByExtension ?? "")) this.updateContent(this.lastMessage);
                }
                const lines = super.render(width);''}
  '';
})
