{
  self,
  optionPath ? [
    "pi"
    "coding-agent"
  ],
}:
{
  config,
  pkgs,
  lib,
  ...
}:

# Everything pi-nix adds on top of lukasl-dev/pi.nix lives here, in a second
# module merged alongside coding-agent/options.nix. That file is upstream's and
# is never edited: this module reaches pi's command line through option
# surfaces upstream already exposes and that merge across definitions —
# `extraArgs`, `extensions`, `skills`, `promptTemplates`, `settings`, and
# `environment`. Keeping the diff to three one-line `imports` additions is what
# makes `git rebase upstream/master` a fast-forward.
let
  inherit (pkgs.stdenv.hostPlatform) system;
  # Upstream's options.nix inherits `coding-agent` from the same attrset and
  # makes it the option default. Taking the sibling here and handing it back
  # through mkDefault is how the fork changes that answer without touching the
  # file that asks the question.
  inherit (self.packages.${system}) coding-agent-bun;

  # The shared schema lives in agent-statusline so claude-nix and pi-nix cannot
  # drift. Each consumer mounts it under its own namespace.
  statuslineLib = self.inputs.agent-statusline.lib.${system};
  statuslinePkgs = self.inputs.agent-statusline.packages.${system};

  cfg = lib.attrByPath optionPath { } config;

  toFile =
    stem: value:
    if value == null then
      null
    else if builtins.isPath value then
      value
    else
      pkgs.writeText stem value;

  systemPromptPath = toFile "pi-SYSTEM.md" cfg.systemPrompt;

  systemPromptArgs = lib.optionals (systemPromptPath != null) [
    "--system-prompt"
    "${systemPromptPath}"
  ];

  extPkgs = cfg.extensionPackages;

  extEntrypoints = lib.concatMap (p: p.passthru.piEntrypoint or [ ]) extPkgs;
  extSkills = lib.concatMap (p: p.passthru.piSkills or [ ]) extPkgs;
  extPrompts = lib.concatMap (p: p.passthru.piPrompts or [ ]) extPkgs;

  # Deep merge, so two extensions contributing to one settings subtree compose
  # rather than the later one erasing the earlier.
  extSettings = lib.foldl' lib.recursiveUpdate { } (map (p: p.passthru.settings or { }) extPkgs);

  # promptFragment is an escape hatch for an extension that supplies no
  # promptSnippet or promptGuidelines of its own. Normally every entry is null
  # and this list is empty.
  promptFragments = lib.filter (f: f != null) (map (p: p.passthru.promptFragment or null) extPkgs);

  promptFragmentFile = pkgs.writeText "pi-extension-prompt-fragments.md" (
    lib.concatStringsSep "\n\n" promptFragments
  );

  # Appended, never used with --system-prompt: an extension may add guidance,
  # it may not replace the prompt.
  promptFragmentArgs = lib.optionals (promptFragments != [ ]) [
    "--append-system-prompt"
    "${promptFragmentFile}"
  ];

  statusline = cfg.statusline;

  statuslineConfigFile = statuslineLib.renderConfig statusline;

  # The package root, not a file: pi's resolveExtensionEntries reads the pi
  # manifest inside agent-statusline's extension package.json and loads what it
  # declares, so the entrypoint filename stays that repo's business.
  statuslineArgs = lib.optionals statusline.enable [
    "--extension"
    "${statusline.extension}"
  ];

  # Upstream's `environment` is nullOr (either path attrs), so this definition
  # and a user's own compose only when both are attrsets. A guard that reads
  # cfg.environment to say so cannot exist: it would be a definition of
  # `environment` whose value forces `environment`, which is an infinite
  # recursion no matter where the read sits. The module system's own "defined
  # multiple times" error is what a consumer sees instead, and the option
  # description below says which form to use.
  statuslineEnv = {
    AGENT_STATUSLINE_BIN.value = "${statusline.package}/bin/agent-statusline";
    AGENT_STATUSLINE_CONFIG.value = "${statuslineConfigFile}";
  };
in
{
  options = lib.setAttrByPath optionPath {
    systemPrompt = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.either lib.types.lines (lib.types.addCheck lib.types.path builtins.isPath)
      );
      default = null;
      description = ''
        System prompt passed to pi via `--system-prompt`, **replacing** pi's
        default prompt entirely. Skills, context files, and the working
        directory are still appended by pi afterwards, and `rules` still
        appends through `--append-system-prompt`, so the two options compose.

        This can be inline text or a Nix path. Upstream's `rules` option only
        appends; replacement is a separate flag and a separate option.
      '';
      example = lib.literalExpression "./SYSTEM.md";
    };

    extensionPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = ''
        pi extension derivations to enable, normally taken from this flake's
        `packages.ext-*` outputs or built with `lib.builders.<system>.mkPiPlugin`.

        Each derivation carries its own wiring on `passthru`: `piEntrypoint`
        becomes `--extension` flags, `piSkills` becomes `--skill`, `piPrompts`
        becomes `--prompt-template`, `settings` is deep-merged into
        `settings.json`, and a non-null `promptFragment` is appended to the
        system prompt. Removing an extension therefore removes its
        configuration too — there is nothing left dangling.
      '';
      example = lib.literalExpression ''
        with inputs.pi-nix.packages.''${pkgs.system}; [
          ext-pi-mcp-adapter
          ext-pi-subagents
        ]
      '';
    };

    statusline = lib.mkOption {
      default = { };
      description = ''
        Statusline rendered under pi, via the agent-statusline pi extension.

        The option schema is imported from agent-statusline and is the same one
        `programs.claude-nix.statusLine` mounts, so a widget added there appears
        here with no change on this side.

        Enabling this exports `AGENT_STATUSLINE_BIN` and
        `AGENT_STATUSLINE_CONFIG` through `environment`, so `environment` must
        be in its attribute-set form. A shell-environment-file value cannot
        merge with these and the evaluation fails.
      '';
      type = lib.types.submodule {
        options = statuslineLib.statuslineOptions // {
          # mkOption returns a plain attrset, so overriding `default` this way
          # keeps the shared type and description while supplying the package
          # this flake's input provides.
          package = statuslineLib.statuslineOptions.package // {
            default = statuslinePkgs.agent-statusline;
          };

          extension = lib.mkOption {
            type = lib.types.package;
            default = statuslinePkgs.pi-extension;
            description = ''
              The agent-statusline pi extension package. Handed to pi as
              `--extension <dir>`; pi reads the `pi` manifest in its
              package.json to find the entrypoint.
            '';
          };
        };
      };
    };

    finalSystemPrompt = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      internal = true;
      readOnly = true;
    };
  };

  config = lib.setAttrByPath optionPath {
    # Everything JavaScript in this stack runs on Bun, pi included. Upstream
    # builds both and defaults to the npm one; mkDefault flips that answer at
    # the lowest possible priority, so any explicit `package = ...` from a
    # consumer still wins and `packages.coding-agent` stays buildable.
    package = lib.mkDefault coding-agent-bun;

    finalSystemPrompt = systemPromptPath;

    # mkAfter so our flags land behind anything the user set, and behind
    # upstream's resourceArgs (which are concatenated before extraArgs in
    # options.nix's wrapper).
    extraArgs = lib.mkAfter (systemPromptArgs ++ promptFragmentArgs ++ statuslineArgs);

    environment = lib.mkIf statusline.enable statuslineEnv;

    extensions = extEntrypoints;
    skills = extSkills;
    promptTemplates = extPrompts;
    settings = extSettings;
  };
}
