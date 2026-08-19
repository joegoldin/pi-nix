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
  promptFragments =
    lib.filter (f: f != null) (map (p: p.passthru.promptFragment or null) extPkgs)
    ++ messagingFragments;

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

  # Design §9's outermost layer. Upstream's default is `[ network mount-cwd ]`,
  # which is enough to reach a model API and edit the working directory and
  # nothing else — no git, no node, no dbus. This widens it to the toolchain pi
  # shells out to plus the same four read-only paths modules/ai/claude.nix
  # allows Claude, so one machine has one answer.
  #
  # It arrives as mkDefault rather than as an edit to the option's own default,
  # because coding-agent/options.nix is upstream's file and stays byte-identical
  # (tests/additive-test.nix hashes it). mkDefault is priority 1000 against the
  # option default's 1500, so this wins over upstream and loses to any consumer
  # who writes `jail.permissions = ...` themselves. Function-typed options do
  # not merge (F802), so replacement is the only composition available either
  # way.
  #
  # Every combinator is written `combinators.x` rather than pulled in with
  # `with combinators;`. `with` loses to an enclosing let binding, and this file
  # already binds `notifications = cfg.notifications`, so `with combinators; [
  # notifications ]` silently hands jail.nix an option submodule instead of a
  # permission. It fails late, at finalPackage, with "attempt to call something
  # which is not a function but a set".
  jailPermissions = combinators: [
    combinators.network
    combinators.mount-cwd
    # pi-notify shells out to notify-send, which needs a talk permission on
    # org.freedesktop.Notifications. Without this the extension is silently
    # inert inside the jail: exec succeeds, nothing appears.
    combinators.notifications
    # The messaging broker is a separate process the extension spawns from
    # inside the sandbox, so its interpreter has to be in there with it. That
    # interpreter is bun, the same runtime pi already is, which is why this is
    # one package rather than the nodejs plus tsx pair upstream's default launch
    # path would have needed.
    (combinators.add-pkg-deps (
      [
        pkgs.gitMinimal
        pkgs.openssh
        pkgs.gnumake
        pkgs.jq
        pkgs.nodejs
        pkgs.python3
        pkgs.ripgrep
        pkgs.fd
        pkgs.gh
        pkgs.libnotify
      ]
      ++ messagingRuntimeInputs
    ))
    # Mirrors modules/ai/claude.nix's extraSandbox.filesystem.allowRead, which
    # is these four paths and no others. 1Password's agent socket covers
    # agent-backed SSH and signing; known_hosts and ~/.ssh/config cover
    # host-key verification and per-host config. Private key files
    # (~/.ssh/id_*) are deliberately ABSENT — the 1Password agent is the
    # supported path here, and the jail is the layer that makes that omission
    # mean something.
    #
    # The agent socket is read-only, which was measured rather than assumed.
    # F7 predicted a read-only bind would refuse the AF_UNIX connect, because
    # connect() wants write on the inode. Under bubblewrap's --ro-bind-try it
    # does not: `ssh-add -l` inside this jail listed the key with the socket
    # bound read-only. If a kernel ever disagrees the failure is loud
    # ("Error connecting to agent: Permission denied") and the fix is to change
    # this one line to try-readwrite. Do not widen the three ~/.ssh entries
    # with it: those are genuinely read-only data.
    (combinators.try-readonly (combinators.noescape "~/.1password/agent.sock"))
    (combinators.try-readonly (combinators.noescape "~/.ssh/known_hosts"))
    (combinators.try-readonly (combinators.noescape "~/.ssh/known_hosts2"))
    (combinators.try-readonly (combinators.noescape "~/.ssh/config"))
    (combinators.try-fwd-env "SSH_AUTH_SOCK")
  ];

  msg = cfg.messaging;

  # Extension-owned config files, with the option's overrides applied on top of
  # the package's own defaults.
  #
  # brokerCommand is set here rather than in the derivation so the extension
  # package does not have to depend on pkgs.bun. Pointing it at a store path is
  # not a tidiness measure: upstream's default path calls
  # getNodeCommand(process.execPath), which falls back to the literal string
  # "node" resolved through PATH whenever the interpreter is not Node, and under
  # coding-agent-bun it never is. With brokerArgs empty the broker is launched
  # as `bun <broker.ts>`, so tsx is never invoked either.
  configFiles = lib.optionalAttrs msg.enable (
    lib.recursiveUpdate msg.package.passthru.configFiles {
      "intercom/config.json" = {
        brokerCommand = lib.getExe pkgs.bun;
        brokerArgs = [ ];
        inherit (msg) inboundTrigger confirmSend;
      };
    }
  );

  configFilesPrelude = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (
      rel: value:
      let
        json = pkgs.writeText "pi-${lib.replaceStrings [ "/" ] [ "-" ] rel}" (builtins.toJSON value);
      in
      # bash
      ''
        mkdir -p -m 0700 "$(dirname "$PI_CODING_AGENT_DIR/${rel}")"
        install -m 0600 ${lib.escapeShellArg "${json}"} "$PI_CODING_AGENT_DIR/${rel}"
      ''
    ) configFiles
  );

  # Upstream's launcher writes settings.json and nothing else, and
  # coding-agent/options.nix stays byte-identical to upstream by construction
  # (tests/additive-test.nix hashes it). So the writer for extension-owned
  # config files hangs off `package` instead: upstream's wrapper execs whatever
  # `package` resolves to, which puts the write after the environment is
  # exported and inside the jail, where $PI_CODING_AGENT_DIR is bind-mounted.
  #
  # It wraps the default rather than whatever a consumer sets, because a
  # definition of `package` that reads `cfg.package` is an infinite recursion.
  # A consumer who supplies their own package supplies their own launcher too.
  withConfigFiles =
    base:
    if configFiles == { } then
      base
    else
      pkgs.writeShellScriptBin "pi" # bash
        ''
          PI_CODING_AGENT_DIR="''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
          ${configFilesPrelude}
          exec ${lib.escapeShellArg (lib.getExe base)} "$@"
        '';

  # piEntrypoint is a LIST (phase 2's contract). With entrypoints = [ ] it holds
  # the package root, so pi reads pi.extensions = ["./index.ts"] from the
  # package's own manifest.
  messagingEntrypoints = lib.optionals msg.enable msg.package.passthru.piEntrypoint;

  messagingSkills = lib.optionals (msg.enable && msg.installSkill) msg.package.passthru.piSkills;

  messagingFragments = lib.optional (
    msg.enable && msg.package.passthru.promptFragment != null
  ) msg.package.passthru.promptFragment;

  messagingRuntimeInputs = lib.optionals msg.enable [ pkgs.bun ];

  # The one env var worth setting. inboundTrigger has no environment override at
  # all, which is why configFiles exists; the ask timeout does.
  messagingEnv = lib.optionalAttrs msg.enable {
    PI_INTERCOM_ASK_TIMEOUT_MS.value = toString (msg.askTimeoutSeconds * 1000);
  };

  notifications = cfg.notifications;

  notificationsPackage =
    if !notifications.enable then
      null
    else if notifications.package == null then
      throw ''
        pi.coding-agent.notifications.enable is set, but
        pi.coding-agent.notifications.package is null.

        The option defaults to this flake's packages.ext-pi-notify, so a null
        here is an explicit choice. Set it to an extension package or leave
        notifications.enable off: "notifications are on" with no notifier is
        exactly the state a user would not notice.
      ''
    else
      notifications.package;

  notificationEntrypoints = lib.optionals (notificationsPackage != null) (
    notificationsPackage.passthru.piEntrypoint or [ ]
  );

  hasEvent = name: lib.elem name notifications.events;

  # Read by pi-notify at runtime through PI_NOTIFY_CONFIG. Not settings.json:
  # ExtensionContext exposes no settings reader (F6), so a piNotify block there
  # would be config the extension cannot see. The notifier path is resolved at
  # build time so nothing searches PATH inside the jail.
  notifyConfigFile =
    if notificationsPackage == null then
      null
    else
      pkgs.writeText "pi-notify.json" (
        builtins.toJSON {
          enabled = true;
          notifier = notifications.notifierCommand;
          inherit (notifications) style appName;
          longToolCallThresholdMs = notifications.longRunningToolSeconds * 1000;
          events = {
            permissionPrompt = hasEvent "needs_input";
            agentSettled = hasEvent "settled";
            longToolCall = hasEvent "long_running_tool";
          };
        }
      );

  notifyEnv = lib.optionalAttrs (notifyConfigFile != null) {
    PI_NOTIFY_CONFIG.value = "${notifyConfigFile}";
  };

  # One definition of `environment`, assembled from every feature that needs a
  # variable. Merging them here rather than contributing three separate
  # definitions keeps the "defined multiple times" failure that F206 describes
  # to a single boundary: the consumer's own definition against ours.
  extraEnv =
    lib.optionalAttrs statusline.enable statuslineEnv // autoModeEnv // notifyEnv // messagingEnv;
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
        default = self.packages.${system}.ext-pi-notify;
        defaultText = lib.literalExpression "pi-nix's packages.ext-pi-notify";
        description = ''
          The `pi-notify` extension derivation. Setting `enable` with a null
          package is an error rather than a silent no-op, because
          "notifications on, no notifier" is precisely the state a user would
          not notice.
        '';
      };

      style = lib.mkOption {
        type = lib.types.enum [
          "notify-send"
          "terminal-notifier"
          "osascript"
        ];
        default = if pkgs.stdenv.hostPlatform.isDarwin then "terminal-notifier" else "notify-send";
        defaultText = lib.literalExpression ''if pkgs.stdenv.hostPlatform.isDarwin then "terminal-notifier" else "notify-send"'';
        description = ''
          Which command-line contract `notifierCommand` speaks. The three differ
          in argument shape, not in capability: `notify-send` takes
          `--app-name`/`--urgency` then title and body, `terminal-notifier` takes
          `-title`/`-message`/`-group`, and `osascript` takes one `-e` statement
          with the text escaped into it.

          Change this together with `notifierCommand`. A mismatch is silent:
          the wrong binary gets a well-formed argv it does not understand.
        '';
      };

      appName = lib.mkOption {
        type = lib.types.str;
        default = "pi";
        description = ''
          Notification title, and on Linux the `--app-name` value the desktop
          groups notifications by.
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

      configFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        internal = true;
        readOnly = true;
        description = "Rendered config handed to pi-notify as PI_NOTIFY_CONFIG.";
      };
    };

    messaging = {
      enable = lib.mkEnableOption ''
        peer messaging between separately launched pi instances.

        This is pi's missing equivalent of Claude Code's ListAgents and
        SendMessage: two pi processes started independently, in different
        terminals or different repositories, can enumerate each other and
        exchange messages while both stay alive. It is NOT subagents: a
        subagent is a child of one session; these are peers.

        Transport is a unix domain socket under the pi agent directory. No
        network, no daemon, no relay, and no remote access of any kind
      '';

      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.ext-pi-intercom;
        defaultText = lib.literalExpression "pi-nix's packages.ext-pi-intercom";
        description = ''
          The messaging extension to install. Must satisfy the mkPiExtension
          passthru contract.
        '';
      };

      inboundTrigger = lib.mkOption {
        type = lib.types.enum [
          "always"
          "replies"
          "never"
        ];
        default = "replies";
        description = ''
          Whether an inbound peer message may start a model turn on its own.

          The broker does not authenticate peers: any process running as this
          user that can open the socket may register and send. Upstream's
          default is `always`, under which such a message immediately starts a
          turn and arrives as a *user* message, which routes around the
          permission layers entirely, since those gate tool calls and not the
          provenance of instructions.

          `replies` (the default here) lets only a reply to a request this
          session originated start a turn. Unsolicited messages are still
          delivered and rendered; they just do not get to drive the agent.
          `never` disables auto-triggering completely.
        '';
      };

      confirmSend = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Require interactive confirmation before ordinary outbound messages.
          Replies are never gated.
        '';
      };

      askTimeoutSeconds = lib.mkOption {
        type = lib.types.ints.positive;
        default = 300;
        description = ''
          How long a blocking request to a peer waits for its answer before
          giving up. The upstream default is 600s; a peer that never answers
          holds the caller's turn for the whole window, so this is set
          deliberately rather than inherited.
        '';
      };

      installSkill = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Also pass the extension's bundled skills via `--skill`.

          Off by default: `~/.agents/skills` is already a discovery path, and
          whether a package-provided skill de-duplicates against it is design
          assumption A3, still unresolved.
        '';
      };
    };

    finalConfigFiles = lib.mkOption {
      type = lib.types.attrsOf lib.types.attrs;
      internal = true;
      readOnly = true;
      description = ''
        Extension-owned config files the launcher installs under
        $PI_CODING_AGENT_DIR. Key is a path relative to that directory.
      '';
    };

    messagingRuntimeInputs = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      internal = true;
      readOnly = true;
      description = "Packages the messaging broker needs inside the jail.";
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
    package = lib.mkDefault (withConfigFiles coding-agent-bun);

    finalSystemPrompt = systemPromptPath;
    finalConfigFiles = configFiles;
    inherit messagingRuntimeInputs;

    # mkAfter so our flags land behind anything the user set, and behind
    # upstream's resourceArgs (which are concatenated before extraArgs in
    # options.nix's wrapper).
    extraArgs = lib.mkAfter (systemPromptArgs ++ promptFragmentArgs ++ statuslineArgs);

    jail.permissions = lib.mkDefault jailPermissions;

    autoMode.configFile = autoModeConfigFile;
    notifications.configFile = notifyConfigFile;

    environment = lib.mkIf (extraEnv != { }) extraEnv;

    extensions =
      extEntrypoints ++ autoModeEntrypoints ++ notificationEntrypoints ++ messagingEntrypoints;
    skills = extSkills ++ messagingSkills;
    promptTemplates = extPrompts;
    settings = extSettings;
  };
}
