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

  autoMode = cfg.autoMode;

  autoModePackage = self.packages.${system}.ext-pi-auto-mode;

  # Read by pi-auto-mode at runtime through PI_AUTO_MODE_CONFIG. It travels as a
  # store path in an environment variable rather than in settings.json, because
  # ExtensionContext exposes no settings reader (F6) and upstream jq-merges
  # settings.json at launch anyway.
  autoModeConfigFile =
    if !autoMode.enable then
      null
    else
      pkgs.writeText "pi-auto-mode.json" (
        builtins.toJSON {
          enabled = true;
          inherit (autoMode)
            allow
            soft_deny
            hard_deny
            environment
            userTurnLimit
            timeoutMs
            delegateToPermissionSystem
            ;
          deterministic = {
            inherit (autoMode.deterministic) allow deny;
          };
          classifierModel = autoMode.model;
        }
      );

  autoModeEntrypoints = lib.optionals autoMode.enable autoModePackage.passthru.piEntrypoint;

  autoModeEnv = lib.optionalAttrs autoMode.enable {
    PI_AUTO_MODE_CONFIG.value = "${autoModeConfigFile}";
  };

  notifications = cfg.notifications;

  notificationsPackage =
    if !notifications.enable then
      null
    else if notifications.package == null then
      throw ''
        pi.coding-agent.notifications.enable is set, but
        pi.coding-agent.notifications.package is null.

        pi ships no notification support and the npm ecosystem has no vetted
        extension, so pi-nix carries a first-party pi-notify — which does not
        exist yet (phase 3 of docs/plans/2026-08-18-pi-nix-agent-stack-design.md).
        Either set notifications.package explicitly or leave
        notifications.enable off.
      ''
    else
      notifications.package;

  notificationArgs = lib.optionals (notificationsPackage != null) (
    notificationsPackage.passthru.piEntrypoint or [ ]
  );

  notificationFlags = lib.concatMap (p: [
    "--extension"
    p
  ]) notificationArgs;

  # Read by pi-notify at runtime. The notifier path is resolved at build time
  # so the extension never has to search PATH inside the jail.
  notificationSettings = lib.optionalAttrs (notificationsPackage != null) {
    piNotify = {
      inherit (notifications) notifierCommand events longRunningToolSeconds;
    };
  };

  # One definition of `environment`, assembled from every feature that needs a
  # variable. Merging them here rather than contributing three separate
  # definitions keeps the "defined multiple times" failure that F206 describes
  # to a single boundary: the consumer's own definition against ours.
  extraEnv = lib.optionalAttrs statusline.enable statuslineEnv // autoModeEnv;
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

    autoMode = {
      enable = lib.mkEnableOption "the pi-auto-mode permission classifier";

      allow = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = ''
          Things the operator has pre-approved, written as plain sentences for
          the classifier to read. A call matching one of these proceeds.
        '';
        example = lib.literalExpression ''[ "reading or searching any file inside the working directory" ]'';
      };

      soft_deny = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = ''
          Destructive or irreversible actions that **explicit user intent
          clears**. The classifier is shown the last `userTurnLimit` user turns
          precisely so it can tell "delete the build dir" from the agent
          deciding to delete something nobody asked about.
        '';
        example = lib.literalExpression ''[ "deleting files the user did not name" ]'';
      };

      hard_deny = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = ''
          Security boundaries. User intent does not clear these and cannot: the
          gate blocks a `hard_deny` even when the classifier answers `allow`,
          so text injected into a tool call or a file cannot talk its way past
          one.
        '';
        example = lib.literalExpression ''[ "reading private SSH keys, API tokens, or password stores" ]'';
      };

      environment = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = ''
          Facts about this machine the classifier should assume while
          reasoning. These are not permissions and grant nothing.
        '';
        example = lib.literalExpression ''[ "this is a NixOS machine; /nix/store is read-only" ]'';
      };

      deterministic = {
        allow = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            Deterministic allow rules, resolved without a model call. Claude
            Code's permission syntax: `Bash(git status:*)`, `Read(/home/joe/**)`.
            A `:*` suffix is a whole-word prefix match.

            A bash command containing a shell control operator (`&&`, `;`, `|`,
            `$(`, a backtick) can never be allowed by a prefix rule, because
            `git status && rm -rf /` starts with `git status `. Such a command
            falls through to the classifier instead.
          '';
          example = lib.literalExpression ''[ "Bash(git status:*)" "Read(/home/joe/**)" ]'';
        };
        deny = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            Deterministic deny rules, in the same syntax. Deny beats allow, and
            unlike allow it still applies to a compound command: refusing to
            deny would be the unsafe direction.
          '';
          example = lib.literalExpression ''[ "Bash(curl:*)" ]'';
        };
      };

      model = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.submodule {
            options = {
              provider = lib.mkOption {
                type = lib.types.str;
                description = "Provider id as pi knows it, for example `anthropic`.";
              };
              modelId = lib.mkOption {
                type = lib.types.str;
                description = "Model id within that provider.";
              };
            };
          }
        );
        default = null;
        description = ''
          Model used for classification. Null uses the session's own model,
          which is the cheapest thing to reason about and the most expensive to
          run, since it bills at the session model's rate.
        '';
        example = lib.literalExpression ''{ provider = "anthropic"; modelId = "claude-haiku-4-5"; }'';
      };

      userTurnLimit = lib.mkOption {
        type = lib.types.ints.positive;
        default = 6;
        description = ''
          How many recent user turns the classifier is shown. Explicit user
          intent clears `soft_deny`, and the classifier cannot judge intent it
          cannot see.
        '';
      };

      timeoutMs = lib.mkOption {
        type = lib.types.ints.positive;
        default = 20000;
        description = ''
          Classifier timeout. On expiry auto mode fails closed: with a UI it
          asks, and in `print` or `json` mode it blocks.
        '';
      };

      delegateToPermissionSystem = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Delegate deterministic matching to `@gotgenes/pi-permission-system` by
          registering pi-auto-mode on its authorizer chain, which fires only for
          asks that package could not resolve. The built-in matcher stays as the
          fallback when that extension is absent.
        '';
      };

      configFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        internal = true;
        readOnly = true;
        description = "Rendered config handed to pi-auto-mode as PI_AUTO_MODE_CONFIG.";
      };
    };

    notifications = {
      enable = lib.mkEnableOption "desktop notifications for pi via the first-party pi-notify extension";

      package = lib.mkOption {
        type = lib.types.nullOr lib.types.package;
        default = null;
        description = ''
          The `pi-notify` extension derivation. Null until pi-nix ships it;
          setting `enable` without a package is an error rather than a silent
          no-op, because "notifications on, no notifier" is precisely the state
          a user would not notice.
        '';
      };

      notifierCommand = lib.mkOption {
        type = lib.types.str;
        default =
          if pkgs.stdenv.hostPlatform.isDarwin then
            "${pkgs.terminal-notifier}/bin/terminal-notifier"
          else
            "${pkgs.libnotify}/bin/notify-send";
        defaultText = lib.literalExpression ''
          if pkgs.stdenv.hostPlatform.isDarwin then
            "''${pkgs.terminal-notifier}/bin/terminal-notifier"
          else
            "''${pkgs.libnotify}/bin/notify-send"
        '';
        description = ''
          Absolute path to the notifier binary pi-notify shells out to.
          Resolved at build time so the path survives inside the jail, where
          the host PATH is not available.
        '';
      };

      events = lib.mkOption {
        type = lib.types.listOf (
          lib.types.enum [
            "needs_input"
            "settled"
            "long_running_tool"
          ]
        );
        default = [
          "needs_input"
          "settled"
          "long_running_tool"
        ];
        description = ''
          Which events raise a notification.

          - `needs_input` — a permission layer raised a prompt
          - `settled` — the agent finished its turn (pi's `agent_settled`)
          - `long_running_tool` — a tool ran longer than
            `longRunningToolSeconds` (pi's `tool_execution_start`/`_end`)
        '';
      };

      longRunningToolSeconds = lib.mkOption {
        type = lib.types.int;
        default = 30;
        description = ''
          Duration a tool must exceed before `long_running_tool` fires.
        '';
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
    extraArgs = lib.mkAfter (
      systemPromptArgs ++ promptFragmentArgs ++ statuslineArgs ++ notificationFlags
    );

    autoMode.configFile = autoModeConfigFile;

    environment = lib.mkIf (extraEnv != { }) extraEnv;

    extensions = extEntrypoints ++ autoModeEntrypoints;
    skills = extSkills;
    promptTemplates = extPrompts;
    settings = lib.recursiveUpdate extSettings notificationSettings;
  };
}
