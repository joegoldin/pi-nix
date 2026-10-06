{ lib }:
# Patches to pi's own build, applied on top of upstream's package so
# package-bun.nix stays upstream's file. Each uses --replace-fail, so a change
# upstream breaks the build rather than silently dropping the patch.
#
# titleOnlyThinking: some OpenAI models, GPT-6 among them, return reasoning
# summaries that are nothing but bold step titles ("**Checking config**"); the
# reasoning itself stays encrypted, and asking for "detailed" summaries makes
# no difference. pi still treats such a block as collapsible: hidden it reads
# "Thinking...", and a click only swaps that for the title. A thinking run made
# only of titles is now shown as its titles and offers no click; thinking with
# real content keeps pi's toggle.
#
# extensionHidesThinking: pi draws a message's thinking inside its own
# assistant message, where no extension can reach it. pi-custom folds runs of
# exploratory tool calls into one line, and the thinking that led to them
# belongs in that run, not left between the line and the prose after it. pi
# now asks a function an extension may set on globalThis under
# Symbol.for("pi-custom.hideThinking"), called with the assistant message,
# and leaves out every thinking block, shown or "Thinking...", when it answers
# true. pi lays a message out when it changes, not when it paints, and the
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
      ${lib.escapeShellArg "this.contentContainer.clear();"} \
      ${lib.escapeShellArg ''
        this.contentContainer.clear();
                // pi-nix: an extension may draw this message's thinking itself (pi-patches.nix).
                this.thinkingHiddenByExtension = globalThis[Symbol.for("pi-custom.hideThinking")]?.(message) === true;
                if (this.thinkingHiddenByExtension) {
                    message = { ...message, content: message.content.filter((c) => c.type !== "thinking") };
                }''}
    substituteInPlace "$out/${file}" --replace-fail \
      ${lib.escapeShellArg "const lines = super.render(width);"} \
      ${lib.escapeShellArg ''
        // pi-nix: the extension's answer can change after layout, as when a call joins a run (pi-patches.nix).
                if (this.lastMessage && (globalThis[Symbol.for("pi-custom.hideThinking")]?.(this.lastMessage) === true) !== (this.thinkingHiddenByExtension === true)) {
                    this.updateContent(this.lastMessage);
                }
                const lines = super.render(width);''}
  '';
})
