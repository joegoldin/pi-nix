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
  '';
})
