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

  # A package declares its entrypoints in package.json's `pi.extensions`, and
  # handing pi the package directory loads every one of them. That is usually
  # what you want, and occasionally not: pi-background-tasks ships
  # anthropic-attribution.ts beside background-tasks.ts, and the attribution
  # half refuses to let pi start at all unless the Anthropic credential is a
  # subscription OAuth token, so a host on API keys gets a dead agent from an
  # extension it installed for background bash.
  #
  # entrypointOverrides names the entrypoints to load, by package pname, and
  # nothing else from that package is loaded. Paths are relative to the
  # package root, matching the spelling in its package.json.
  # Keyed by the package name as it appears in extensions.json, not by the
  # derivation's pname: packaging prefixes those with `pi-ext-`, and nobody
  # writing this option would think to.
  entrypointKeyOf = p: lib.removePrefix "pi-ext-" (p.pname or "");

  entrypointsOf =
    p:
    let
      override = cfg.entrypointOverrides.${entrypointKeyOf p} or null;
    in
    if override == null then
      p.passthru.piEntrypoint or [ ]
    else
      map (e: "${p}/${lib.removePrefix "./" e}") override;

  extEntrypoints = lib.concatMap entrypointsOf extPkgs;

  # Handing pi a package *root* makes it read that package's manifest, and it
  # loads the skills and prompts declared there by itself. Passing them again
  # registers each one twice, which pi reports at startup as a collision
  # against its own path and then skips.
  #
  # Handing it a specific entrypoint file instead — which is what an
  # entrypointOverrides entry does — skips the manifest, so those packages do
  # need their skills and prompts passed explicitly.
  readsOwnManifest = p: entrypointsOf p == [ "${p}" ];
  needsExplicitResources = lib.filter (p: !(readsOwnManifest p)) extPkgs;

  extSkills = lib.concatMap (p: p.passthru.piSkills or [ ]) needsExplicitResources;
  extPrompts = lib.concatMap (p: p.passthru.piPrompts or [ ]) needsExplicitResources;

  # Deep merge, so two extensions contributing to one settings subtree compose
  # rather than the later one erasing the earlier.
  extSettings = lib.foldl' lib.recursiveUpdate { } (map (p: p.passthru.settings or { }) extPkgs);

  # The same treatment for config that does not live in settings.json. An
  # extension whose settings live in its own file under the agent directory
  # carries them on passthru.configFiles, and the launcher installs each one.
  # pi-permission-system's authorizerChain (docs/assumption-a2.md) is the second
  # case in this class after pi-intercom's inboundTrigger.
  extConfigFiles = lib.foldl' lib.recursiveUpdate { } (
    map (p: p.passthru.configFiles or { }) extPkgs
  );

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

  # `$defaults` is pi-automode's sentinel for "keep this section's built-in
  # rules as well as mine". It is not written here. A rule list arriving from
  # Nix is the operator's whole policy for that section, and prepending the
  # sentinel would union it with a stranger's prose that changes on every
  # version bump. A caller who wants the built-ins says so by putting
  # `$defaults` in the list themselves, which is the sensible answer for
  # `protectedPaths`, a fixed path gate, and rarely the right one for the four
  # prose lists.
  #
  # An empty list is not the same as no list, and the two are spelled
  # differently here because the package distinguishes them. Any array at all
  # sets `seen` in its accumulator (config.ts's applyRuleSetting), and
  # finalizeRuleSetting then takes the built-ins as its base only when the
  # section was never seen. So `[ ]` means "replace the built-ins with
  # nothing", and `null` -- the default -- means "this section was never
  # configured; leave the built-ins alone" by being left out of the rendered
  # file entirely.
  #
  # Collapsing the two, as an earlier version of this did, silently drops an
  # operator's explicit `[ ]` and hands back all of the built-ins instead.

  # Only what the operator actually set. Every key omitted here falls through
  # to the package's own default, which is the value its docs describe; writing
  # a Nix-side copy of that default would be a second place to keep in sync.
  setKeys = lib.filterAttrs (_: v: v != null && v != [ ]);

  # Rule sections keep an explicit `[ ]`; only `null` means unset.
  setRules = lib.filterAttrs (_: v: v != null);

  autoModePermissions = setKeys { inherit (autoMode.permissions) deny ask; };

  # pi-automode reads three sources and pi's settings.json is not one of them:
  # `~/.pi/agent/automode.json`, `.pi/automode.local.json`, and the
  # PI_AUTOMODE_SETTINGS_JSON environment variable, which carries the settings
  # as inline JSON rather than as a path (config.ts's
  # loadEffectiveConfigWithDiagnostics: `JSON.parse(process.env...)`).
  #
  # The environment variable is the one Nix should use, and the `file` tag on
  # upstream's `environment` option is what makes that ergonomic: it exports
  # `"$(cat <store path>)"`, so the rules travel as an immutable store file
  # that rolls back with the generation, lands in the runtime closure the jail
  # binds, and never writes into the user's home.
  #
  # The alternative, `configFiles."automode.json"`, would have been wrong here
  # in a way that is easy to miss. That contract installs relative to
  # PI_CODING_AGENT_DIR, while pi-automode's global path is
  # `resolve(HOME, ".pi/agent/automode.json")` (constants.ts), anchored to the
  # home directory and honouring no override. The two agree by default and only
  # by default, and a consumer who repoints PI_CODING_AGENT_DIR would get a file
  # the guardrail never reads and its built-in rules instead of theirs.
  #
  # Inline settings are also the highest-precedence source, which is the right
  # place for a rule set the operator declared in Nix: a checked-out project's
  # `.pi/automode.local.json` can still ADD rules, but it cannot turn auto mode
  # off or swap the classifier model out from under it.
  autoModeSettings = {
    autoMode = {
      enabled = true;
      log = {
        enabled = autoMode.log.enable;
        inherit (autoMode.log) classifierIo;
      };
    }
    // setKeys {
      inherit (autoMode)
        classifierModel
        classifierReasoningLevel
        classifyReadOnlyTools
        allowInsideWorkingDirectory
        fastClassifierMaxTokens
        maxUserTranscriptTokens
        maxToolTranscriptTokens
        ;
    }
    // setRules {
      inherit (autoMode)
        environment
        allow
        soft_deny
        hard_deny
        protectedPaths
        ;
    }
    // {
      # deniedPaths ships no built-in entries at all, so there is nothing for a
      # sentinel to keep and nothing an empty list could mean beyond "none".
      inherit (autoMode) deniedPaths;
    };
  }
  // lib.optionalAttrs (autoModePermissions != { }) { permissions = autoModePermissions; };

  autoModeConfigFile =
    if !autoMode.enable then
      null
    else
      pkgs.writeText "pi-automode.json" (builtins.toJSON autoModeSettings);

  autoModeEnv = lib.optionalAttrs autoMode.enable {
    # A string, not the derivation: the `file` tag is `either str path`, and a
    # writeText result is neither until it is interpolated.
    PI_AUTOMODE_SETTINGS_JSON.file = "${autoModeConfigFile}";
  };

  # Two gates on one event used to be one gate too many. pi dispatches
  # `tool_call` to every extension in `--extension` order and returns on the
  # first `{ block: true }` (pi-coding-agent 0.84.2,
  # `dist/core/extensions/runner.js`'s emitToolCall), and both packages register
  # there: @gotgenes/pi-permission-system through createFailClosedToolCall,
  # pi-automode through its own handler. Whichever loads first answers every
  # ask, and the other one is dead code.
  #
  # The way out is not ordering, it is the seam the permission system publishes
  # for it: a typed service on
  # Symbol.for("@gotgenes/pi-permission-system:service") carrying
  # registerAuthorizer(name, authorize), consulted only for an `ask` its own
  # deterministic engine could not settle. Upstream pi-automode does not use it.
  # The fork this repo builds (packages/extensions/czottmann-pi-automode.nix)
  # does, so auto mode is a link on that chain rather than a competing gate, and
  # the two compose. docs/assumption-a2.md carries the whole argument.
  #
  # Two things that arrangement needs from here.
  #
  # First, load order, inverted from what it was. Auto mode goes *ahead* of the
  # rest so its `tool_call` handler sees the real event, with the real tool
  # input, before the permission system raises an ask over it. The chain link
  # then reviews that event rather than a projection rebuilt from the ask's
  # display fields. In delegated mode that first pass runs only the
  # deterministic tiers, which cost no model call; the classifier runs once, in
  # the link.
  #
  # Second, activation. Registration alone decides nothing: the permission
  # system consults a link only when the operator names it in `authorizerChain`,
  # in that package's own config file rather than in pi's settings.json. That is
  # F301, and F307 is the same finding arriving in production — an option that
  # evaluated, built green, and did nothing. `autoMode.permissionSystem` below
  # writes that file through phase 7's configFiles, so naming the link is not
  # something a person has to remember.
  permissionSystemPnames = [
    "pi-ext-gotgenes-pi-permission-system"
    "@gotgenes/pi-permission-system"
  ];

  permissionSystemPresent = lib.any (p: lib.elem (p.pname or "") permissionSystemPnames) extPkgs;

  chain = autoMode.permissionSystem;

  # The link is worth writing only when both halves are actually loaded.
  chainActive = autoMode.enable && permissionSystemPresent && chain.enable;

  chainNames = chain.settings.authorizerChain or [ chain.authorizerName ];

  # Naming the link is the half that arms it, so a chain the operator wrote by
  # hand without our name in it is refused rather than written. F307 is what
  # that mistake looks like when it ships: a green build, an evaluated option,
  # and every ask going to a dialog.
  permissionSystemSettings =
    if chainActive && !(lib.elem chain.authorizerName chainNames) then
      throw ''
        pi.coding-agent.autoMode.permissionSystem.settings.authorizerChain is
        set to ${builtins.toJSON chainNames} and does not name
        "${chain.authorizerName}".

        Registration is not activation: @gotgenes/pi-permission-system consults
        a link only when the operator names it in authorizerChain, so this
        would install auto mode as a chain link that is never called and send
        every ask its deterministic engine cannot settle to a dialog.

        Add "${chain.authorizerName}" to that list, drop the list and take the
        computed default, or set
        pi.coding-agent.autoMode.permissionSystem.enable = false.
      ''
    else
      chain.settings // { authorizerChain = chainNames; };

  permissionSystemConfigFiles = lib.optionalAttrs chainActive {
    "extensions/pi-permission-system/config.json" = permissionSystemSettings;
  };

  # pi-subagents resolves the permission system by package name so it can hand
  # it to the child, and tries two locations in order: `npm/node_modules/<name>`
  # and then `extensions/<name>` (its `resolvePermissionSystemExtension`). A Nix
  # install populates neither, because the package lives in the store -- but the
  # SECOND one exists anyway, since that is where `permissionSystemConfigFiles`
  # writes config.json. The resolver finds that directory, demands a
  # package.json it has no reason to contain, and refuses to spawn: subagents
  # fail with "Permission-system package manifest is missing", which reads like
  # a permission denial and is a failed path lookup.
  #
  # The manifest goes in the FIRST location, and putting it in the second
  # instead would be a quiet mistake. `extensions/` is one of pi's discovery
  # roots, and loader.js's rule 3 is that a subdirectory whose package.json
  # carries a `pi` field is loaded -- so a manifest dropped next to that
  # config.json would register the permission system a second time, on top of
  # the `--extension` flag that already loads it. That directory is inert today
  # precisely because it holds no manifest. `npm/node_modules` is not a
  # discovery root; nothing walks it, and only a resolver asking for a name
  # reads it.
  #
  # Keyed on the package being loaded at all rather than on `chainActive`: a
  # subagent needs to find it whenever it is present, whether or not this
  # config also names it as an authorizer link.
  permissionSystemPackage = lib.findFirst (
    p: lib.elem (p.pname or "") permissionSystemPnames
  ) null extPkgs;

  npmLinks = lib.optionalAttrs (permissionSystemPackage != null) {
    "@gotgenes/pi-permission-system" = permissionSystemPackage;
  };

  # `ln -sfn` onto an existing real directory would link INSIDE it rather than
  # replace it, so a directory pi's own package manager installed is left
  # alone. Only an absent path or a symlink we own is (re)written, which also
  # makes the store path follow the generation on every launch.
  npmLinksPrelude = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (
      name: drv:
      # bash
      ''
        npm_link="$PI_CODING_AGENT_DIR/npm/node_modules/${name}"
        if [ ! -e "$npm_link" ] || [ -L "$npm_link" ]; then
          mkdir -p -m 0700 "$(dirname "$npm_link")"
          ln -sfn ${lib.escapeShellArg "${drv}"} "$npm_link"
        fi
      '') npmLinks
  );

  autoModeEntrypoints = lib.optionals autoMode.enable autoMode.package.passthru.piEntrypoint;

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

  # `nix` is not in the generic list above, and that is the deliberate half of
  # this option. Every pi-nix consumer is a Nix user, which argues for shipping
  # it; but making it *work* is not one package. jail.nix's base binds only the
  # runtime closure of the wrapped program into /nix/store, and the daemon
  # socket is not bound at all, so a bare `pkgs.nix` inside the jail cannot
  # copy a flake into the store, cannot reach a builder, and cannot read a
  # result path it did somehow produce. Making the rule "nix build and nix eval
  # are read-only" reachable means binding the whole store and the daemon
  # socket, and that is a different jail: the package list stops being an
  # execution allowlist, because anything the agent can build it can then run.
  #
  # That is a trade the operator should make on purpose, in their own config,
  # which is why it is an option that defaults to off rather than another line
  # in the list above.
  nixRuntimeInputs = lib.optionals cfg.jail.nixAccess [ pkgs.nix ];

  nixJailPermissions =
    combinators:
    lib.optionals cfg.jail.nixAccess [
      # Read-only, and the whole store rather than the closure: evaluation
      # reads the paths the daemon just wrote, and it cannot read what is not
      # bound. The store is world-readable on the host already.
      (combinators.try-readonly "/nix/store")
      # The daemon does the writing. Read-write because it is a socket, and
      # connect() wants write.
      (combinators.try-readwrite "/nix/var/nix/daemon-socket/socket")
      (combinators.try-readonly "/nix/var/nix/db")
    ];

  jailPermissions =
    combinators:
    [
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
          # Upstream's own settings prelude runs `cmp -s` bare, while every
          # other tool it calls is a resolved store path. Outside a jail the
          # ambient PATH covers that; inside --clearenv it does not, and pi
          # exits before it starts with "cmp: command not found". cmp is in
          # diffutils, not coreutils, so prepending coreutils does not reach it.
          pkgs.diffutils
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
          # gdbus, for closing a notification once its ask is answered.
          # CloseNotification is a D-Bus method with no CLI of its own, and the
          # `notifications` combinator already grants talk on that destination,
          # so this is the only missing piece.
          pkgs.glib.bin
          # The shell pi's bash tool actually runs, and the one a person types
          # into. pi resolves its shell as /bin/bash, then bash on PATH, then
          # bare `sh` (pi-coding-agent's dist/utils/shell.js). Inside
          # --clearenv there is no /bin/bash and no PATH but the one
          # add-pkg-deps builds, so without this every tool call lands on the
          # `sh` that jail.nix's base binds at /bin/sh, and anything using
          # bash syntax fails in a way that reads as the model's mistake.
          #
          # fish is here because it is the shell the operator has, not as a
          # second way to run tool calls: pi never consults $SHELL for those.
          # It is what an interactive escape hatch should feel like, and what
          # `$SHELL` should point at rather than at nologin.
          pkgs.bashInteractive
          pkgs.fish
          # Reported missing by `/doctor` inside the jail. Each one is
          # something the agent's own instructions assume it can run: curl for
          # fetching, sed/grep/find for the read-only inspection the allow
          # rules name, procps for `ps`/`free` when a command has to be
          # explained rather than guessed at.
          pkgs.curl
          pkgs.gnused
          pkgs.gnugrep
          pkgs.findutils
          pkgs.procps
          # A second /doctor run inside the jail found these two. direnv is not
          # a convenience: every repository on this machine that uses devenv
          # hydrates its toolchain from a .envrc, and without direnv the agent
          # gets the un-hydrated environment and then debugs the wrong thing.
          # hostname is trivial and worth the byte anyway, because its absence
          # reads as a broken machine rather than as a deliberate sandbox and
          # sends whoever hits it looking for a fault that is not there.
          pkgs.direnv
          pkgs.hostname
          # The floor an agent assumes rather than checks. Measured inside the
          # jail rather than guessed: each of these came back "not found" from a
          # probe that ran the real bwrap argv with a shell in pi's place.
          #
          # tar is the one that actually breaks work. coreutils does not carry
          # it, so anything that unpacks a release tarball or a `git archive`
          # fails on a missing binary rather than on anything to do with the
          # task, and the compression tools are the same story one layer down.
          # less matters because git and other tools spawn a pager and get a
          # "not found" instead. file, which and tree are small, and their
          # absence reads as a broken machine rather than a deliberate sandbox,
          # which is the failure mode this list exists to avoid.
          # gawk before the rest because its absence is the least visible: a
          # shell one-liner with an awk stage fails mid-pipeline, and the model
          # reads that as its own syntax error rather than as a missing binary.
          # Nothing else in this list provides it -- not coreutils, not gnused,
          # not gnugrep.
          pkgs.gawk
          pkgs.gnutar
          pkgs.gzip
          pkgs.xz
          pkgs.unzip
          pkgs.less
          pkgs.file
          pkgs.which
          pkgs.tree
        ]
        ++ nixRuntimeInputs
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
      # $SHELL inside the jail is whatever the host exported, which on NixOS is
      # a nologin binary once --clearenv has dropped everything else. Programs
      # that spawn "the user's shell" then fail oddly rather than obviously.
      # pi's own tool calls do not read it (see the bash resolution above), so
      # this is only for what pi spawns.
      (combinators.set-env "SHELL" "${lib.getExe pkgs.fish}")
    ]
    ++ nixJailPermissions combinators
    # Spliced rather than left for the consumer to remember. jail.permissions is
    # function-typed, and `functionTo (listOf raw)` does merge: every definition
    # is applied to the same combinators and the results concatenate. But a
    # consumer who writes a plain (non-mkDefault) definition replaces this whole
    # list, and a microphone that is simply absent reports no error at all. The
    # same function is exposed as `voice.jailPermissions` for exactly that case.
    ++ cfg.voice.jailPermissions combinators
    ++ extrasJailPermissions combinators;

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
  configFiles = lib.recursiveUpdate (lib.recursiveUpdate extConfigFiles permissionSystemConfigFiles) (
    lib.optionalAttrs msg.enable (
      lib.recursiveUpdate msg.package.passthru.configFiles {
        "intercom/config.json" = {
          brokerCommand = lib.getExe pkgs.bun;
          brokerArgs = [ ];
          inherit (msg) inboundTrigger confirmSend;
        };
      }
    )
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
    if configFiles == { } && npmLinks == { } then
      base
    else
      pkgs.writeShellScriptBin "pi" # bash
        ''
          PI_CODING_AGENT_DIR="''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
          ${configFilesPrelude}
          ${npmLinksPrelude}
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

  voice = cfg.voice;

  # `--stream` and `-t` are added by the extension itself, so this carries only
  # what Nix has an opinion about. The device is named here rather than left to
  # audiomemo's own `record.device`, because its picker is an interactive TUI
  # and `--stream` is headless.
  voiceArgs =
    lib.optionals (voice.device != null) [
      "-D"
      voice.device
    ]
    ++ voice.extraArgs;

  voiceEnv = lib.optionalAttrs voice.enable (
    {
      # An absolute store path, not `record` on PATH: inside the jail nothing is
      # on PATH unless a permission put it there, and the closure this points at
      # is the one add-pkg-deps binds.
      PI_VOICE_RECORD_BIN.value = "${voice.audiomemo}/bin/record";
      PI_VOICE_RECORD_ARGS.value = lib.concatStringsSep " " voiceArgs;
      PI_VOICE_BAR_WIDTH.value = toString voice.barWidth;
      PI_VOICE_PLACEMENT.value = voice.placement;
    }
    # Key *paths*, never key values. audiomemo opens the file itself
    # (internal/config/config.go), so no secret enters the store or this
    # process's environment.
    // lib.mapAttrs (_: path: { value = path; }) voice.keyFiles
  );

  voiceEntrypoints = lib.optionals voice.enable voice.package.passthru.piEntrypoint;

  extras = cfg.extras;

  # The clipboard crosses the jail boundary as text, not as a socket.
  #
  # jail.nix ships a `wayland` combinator, and it is the wrong tool here twice
  # over. It hard-fails: `fwd-env` exits non-zero when the variable is unset and
  # `readonly` errors when the path is missing, so adding it stops pi starting
  # on a TTY, over SSH, or on any host without a compositor. And it grants a
  # live compositor connection to copy a line of text, which is far more
  # authority than the job needs.
  #
  # `jail-to-host-channel` is the primitive that fits: one named program inside
  # the jail whose single argument is piped to a script outside it. No socket is
  # bound, no WAYLAND_DISPLAY is forwarded, and a headless host degrades to a
  # failing copy rather than a session that will not start.
  extrasClipboardChannel = "piExtrasCopyToHost";

  # The channel takes its text as argv[1]; the extension writes to stdin
  # (clipboard.ts's spawnRunner). This shim is the whole bridge.
  extrasClipboardShim = pkgs.writeShellApplication {
    name = "pi-extras-copy";
    text = ''
      exec ${extrasClipboardChannel} "$(cat)"
    '';
  };

  extrasEnv = lib.optionalAttrs extras.enable {
    PI_EXTRAS_CLIPBOARD.value = "${lib.getExe extrasClipboardShim}";
    PI_EXTRAS_GIT_EDITOR.value = extras.gitEditorCommand;
  };

  extrasEntrypoints = lib.optionals extras.enable extras.package.passthru.piEntrypoint;

  extrasJailPermissions =
    combinators:
    lib.optionals (extras.enable && extras.clipboardCommand != null) [
      (combinators.jail-to-host-channel extrasClipboardChannel ''
        printf '%s' "$1" | ${extras.clipboardCommand}
      '')
      (combinators.add-pkg-deps [ extrasClipboardShim ])
    ];

  foreignSkillsEntrypoints = lib.optionals cfg.foreignSkills.enable cfg.foreignSkills.package.passthru.piEntrypoint;

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
          inherit (notifications) dismissOnResolve;
          dismisser = notifications.dismisserCommand;
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
    lib.optionalAttrs statusline.enable statuslineEnv
    // autoModeEnv
    // notifyEnv
    // messagingEnv
    // voiceEnv
    // extrasEnv;
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

    entrypointOverrides = lib.mkOption {
      type = lib.types.attrsOf (lib.types.listOf lib.types.str);
      default = { };
      description = ''
        Load only these entrypoints from a package, keyed by the package name
        as it appears in `extensions.json` (`pi-background-tasks`, not the
        derivation's `pi-ext-pi-background-tasks`).

        A pi package declares its entrypoints in `package.json` under
        `pi.extensions`, and handing pi the package directory loads all of
        them. That is usually right. It is wrong when a package ships a second
        extension you did not install it for, and that extension changes how pi
        behaves.

        The case this exists for: `pi-background-tasks` ships
        `anthropic-attribution.ts` beside `background-tasks.ts`, and the
        attribution half throws unless the Anthropic credential is a
        subscription OAuth token. On a host authenticating with API keys it
        stops pi from starting at all, including `pi auth check`, and neither
        `--no-extensions` nor removing the environment variable reaches it,
        because the launcher passes explicit `--extension` paths.

        Paths are relative to the package root and are spelled as they appear
        in the package's own `package.json`. Naming an entrypoint that does not
        exist is not detected here; pi reports it at load.
      '';
      example = lib.literalExpression ''
        {
          pi-background-tasks = [ "./extensions/background-tasks.ts" ];
        }
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

    jail.nixAccess = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Put `nix` inside the jail, and with it the whole of /nix/store
        read-only, the daemon socket read-write, and the database read-only.
        Off by default.

        The package alone is not enough to be useful. jail.nix binds only the
        wrapped program's own runtime closure into /nix/store, so without the
        wider binds `nix eval` cannot read the flake the daemon just copied in,
        and `nix build` produces a path the jail cannot see.

        With them, a rule like "nix build and nix eval are read-only" becomes
        true instead of merely stated. The package list also stops being an
        execution allowlist, because anything the agent can build it can also
        run. On a machine whose repositories are Nix, that is usually the right
        trade. It is not one this module should make for you.
      '';
    };

    jail.privateAgentSubdirs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "pi-pretty" ];
      description = ''
        Paths under the coding-agent directory, relative to it, that each
        jailed session gets as its own tmpfs instead of the host's shared
        directory. Empty by default, and it costs whatever persistence the
        named path held.

        The reason is an interaction between the jail and any extension that
        keeps an LMDB environment there. jail.nix passes `--unshare-pid`, so
        every session's pi is pid 2 inside its own namespace. LMDB's reader
        table takes an fcntl write lock on the byte at offset `pid` in
        `lock.mdb` (`mdb_reader_pid`), so a second concurrent session asks the
        kernel for a byte the first one already holds and `mdb_txn_begin`
        returns EAGAIN. Observed as `@heyhuynhgiabuu/pi-pretty` refusing to
        start a session while another was open:

          Error: FFF init failed: Failed to start read transaction for
          frecency database: Resource temporarily unavailable (os error 11)

        and confirmed in /proc/locks as `POSIX ADVISORY WRITE <pid> <dev>:2 2`
        against that lock file, offset 2 being the in-namespace pid.

        A private inode per session is the whole fix, and it is also the whole
        cost: two sessions cannot share the database, so whatever it
        accumulated is per-session from here on. Nothing else works while
        `--unshare-pid` stands, and dropping that would hand the agent the
        host's /proc.
      '';
    };

    autoMode = {
      enable = lib.mkEnableOption "the @czottmann/pi-automode guardrail";

      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.ext-czottmann-pi-automode;
        defaultText = lib.literalExpression "pi-nix's packages.ext-czottmann-pi-automode";
        description = ''
          The auto-mode extension derivation. Its `passthru.piEntrypoint`
          becomes the `--extension` flag; the rest of this option block is
          rendered to JSON and exported as `PI_AUTOMODE_SETTINGS_JSON`, which
          is the package's highest-precedence config source.
        '';
      };

      allow = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = ''
          Exceptions to `soft_deny`, written as plain sentences for the
          classifier to read. They are exceptions, not grants: an action still
          reaches the classifier, and no `allow` sentence clears a `hard_deny`.

          A list REPLACES the package's built-in allow rules rather than adding
          to them. Put the literal `$defaults` in the list to keep them as
          well. `null`, the default, leaves the built-ins alone; `[ ]` is a
          real value meaning "no allow rules at all".
        '';
        example = lib.literalExpression ''[ "reading or searching any file inside the working directory" ]'';
      };

      soft_deny = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = ''
          Destructive or irreversible actions that **explicit user intent
          clears**. The classifier is shown recent user messages and the
          agent's own tool-call inputs precisely so it can tell "delete the
          build dir" from the agent deciding to delete something nobody asked
          about. A tool result never counts as intent, ask-user tools included:
          untrusted text must not be able to authorise anything.
        '';
        example = lib.literalExpression ''[ "deleting files the user did not name" ]'';
      };

      hard_deny = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = ''
          Security boundaries. User intent does not clear these and cannot: the
          classifier contract refuses `allow` on a `hard_deny` tier outright,
          and an unparseable verdict blocks, so text injected into a tool call
          or a file cannot talk its way past one.
        '';
        example = lib.literalExpression ''[ "reading private SSH keys, API tokens, or password stores" ]'';
      };

      environment = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = ''
          Facts about this machine the classifier should assume while
          reasoning. These are not permissions and grant nothing.
        '';
        example = lib.literalExpression ''[ "this is a NixOS machine; /nix/store is read-only" ]'';
      };

      protectedPaths = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = ''
          Repository-relative paths whose writes always reach the classifier.
          A list replaces the package's built-in list (`.git`, `.pi`, shell
          profiles, package-manager configs, hook configs, build-wrapper
          properties); write `$defaults` as the first entry to keep it and add
          to it, which is usually what this list wants. `null`, the default,
          leaves the built-ins alone. `[ ]` is a real value meaning "gate no
          paths", which hands the whole question to the classifier. It only matters when
          `allowInsideWorkingDirectory` is on, which is what gives in-tree
          writes a deterministic allow; a protected target is carved back out
          of it.
        '';
        example = lib.literalExpression ''[ "flake.lock" ]'';
      };

      deniedPaths = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = ''
          Glob patterns the file tools (`read`, `write`, `edit`, `grep`,
          `find`, `ls`) may never touch. Matched before the classifier and
          before every fast path, against both the path as written and its
          symlink-resolved form, so a secret never reaches the model through a
          file read. `~`, `$HOME` and `''${HOME}` expand, and `*` matches `/`
          as well, so `**/id_rsa` catches a key at any depth.

          It governs file tools only. `bash` access to the same paths is the
          classifier's and the deterministic hard-deny checks' problem, which
          is an argument for writing the rule in both places.
        '';
        example = lib.literalExpression ''[ "~/.ssh/*" "*.env" ]'';
      };

      permissions = {
        deny = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            Tool patterns blocked before anything else runs, resolved without a
            model call: `bash(rm -rf *)`, `write(.env*)`, `edit(.env*)`. Pi's
            tool names are lowercase; the parser accepts `Bash(...)` too.

            There is no matching allow list, by design. Every side-effecting
            action goes to the classifier, so a prefix rule cannot be talked
            into clearing `git status --short && rm -rf ...` the way a
            Claude-Code-style allow list can.
          '';
          example = lib.literalExpression ''[ "bash(git push --force*)" ]'';
        };

        ask = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            Tool patterns that prompt before reaching the classifier, in the
            same syntax. With no UI (`--print`, `--json`, a subagent) a match
            blocks instead of asking, which is the fail-closed direction.
          '';
          example = lib.literalExpression ''[ "bash(git push *)" ]'';
        };
      };

      classifierModel = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          Classifier model, as `provider/model-id` in pi's own spelling, the
          left column of `pi --list-models`. Null uses the session's own model,
          which is the cheapest thing to reason about and the most expensive to
          run: the classifier fires on every side-effecting tool call and bills
          at the session model's rate.

          A model id that does not resolve is not a soft failure. The
          classifier cannot run, so every action it would have judged is
          blocked.
        '';
        example = "anthropic/claude-haiku-4-5";
      };

      classifierReasoningLevel = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "low"
            "medium"
            "high"
            "xhigh"
            "max"
          ]
        );
        default = null;
        description = ''
          Reasoning effort requested for both classifier stages. Null sends no
          preference and leaves the choice to the provider. pi clamps a level
          the model cannot serve, and a non-reasoning model resolves to `off`.

          Raising this without raising `fastClassifierMaxTokens` is a way to
          fail closed on everything: reasoning tokens can consume the 512-token
          fast-stage budget before the model emits the one digit that stage
          exists to produce.
        '';
      };

      classifyReadOnlyTools = lib.mkOption {
        type = lib.types.nullOr lib.types.bool;
        default = null;
        description = ''
          Route `read`, `grep`, `find` and `ls` through the classifier as well.
          Off by default: they are allowed once the permission rules and the
          deterministic checks have had their say. Turning it on lets policy
          refuse a read outside the trusted tree, and costs a model call on
          every one of the agent's most frequent tools.
        '';
      };

      allowInsideWorkingDirectory = lib.mkOption {
        type = lib.types.nullOr lib.types.bool;
        default = null;
        description = ''
          Allow file-tool access inside the working directory with no
          classifier call, and send file access outside it to the classifier
          including reads. The Codex and Claude Code "inside the sandbox is
          silent, outside is reviewed" model. Writes and edits to protected
          in-tree paths are carved out and still classified.
        '';
      };

      fastClassifierMaxTokens = lib.mkOption {
        type = lib.types.nullOr lib.types.ints.positive;
        default = null;
        description = ''
          Token budget for the one-token first stage. Null leaves the
          package's default of 512. Must be at least 16.
        '';
      };

      maxUserTranscriptTokens = lib.mkOption {
        type = lib.types.nullOr lib.types.ints.positive;
        default = null;
        description = ''
          Approximate budget for the user messages shown to the classifier.
          Null leaves the package's default of 4000. Explicit user intent
          clears `soft_deny`, and the classifier cannot judge intent it cannot
          see, so this is the knob that decides how far back "the user asked
          for this" reaches. Must be at least 32.
        '';
      };

      maxToolTranscriptTokens = lib.mkOption {
        type = lib.types.nullOr lib.types.ints.positive;
        default = null;
        description = ''
          Approximate budget for the agent's own tool-call inputs shown to the
          classifier. Null leaves the package's default of 4000. Assistant
          prose and tool results are never included. Must be at least 32.
        '';
      };

      log = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = ''
            Write one JSONL line per decision, and a ccusage-compatible usage
            line per classifier response, beside the session file as
            `<session-id>-pi-automode.jsonl`. Off by default. Logging is
            fail-open: a write error never changes a verdict.
          '';
        };

        classifierIo = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = ''
            Also log the classifier's full prompt, raw responses and parsed
            decision. The prompt carries the selected transcript evidence, so
            this writes conversation content to disk. It is the same payload
            the classifier endpoint already receives on every call, which is
            the honest way to think about the privacy cost.
          '';
        };
      };

      permissionSystem = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = ''
            Register auto mode as a link on `@gotgenes/pi-permission-system`'s
            authorizer chain, and write that package's config file naming the
            link, whenever both extensions are enabled.

            The two packages both gate pi's `tool_call` event, and pi returns on
            the first extension that blocks, so without this only one of them
            decides anything. The chain seam is the composition the permission
            system publishes for exactly that: a link reviews an `ask` its
            deterministic engine could not settle and answers allow, deny, or
            defer. The auto-mode classifier becomes that link, and the
            permission system's own rules keep resolving everything they can
            with no model call.

            Turning this off does not make the pair safe to run together. It
            restores the arrangement where the permission system prompts for
            every ask its rules do not cover and the classifier is never asked.
          '';
        };

        authorizerName = lib.mkOption {
          type = lib.types.str;
          default = "pi-automode";
          description = ''
            The link name. It has to match the name the extension registers
            under, which is `AUTHORIZER_NAME` in the fork's
            `extensions/auto-mode/permission-chain.ts`. A name the operator
            configures and no extension registers is skipped with a warning —
            more prompting, never less — so a mismatch here costs prompts
            rather than authority.
          '';
        };

        settings = lib.mkOption {
          type = lib.types.attrs;
          default = {
            debugLog = false;
            permissionReviewLog = true;
            yoloMode = false;
          };
          description = ''
            The whole of `$PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json`,
            minus `authorizerChain`, which is computed. The launcher installs
            this file on every start, so it replaces whatever is on disk rather
            than merging into it: anything the operator wants kept has to be
            named here.

            The default is that package's own three defaults.
            `permissionReviewLog` is left on because the review log is the
            evidence that a decision came from the chain link rather than from a
            dialog, and that distinction is the whole point of the arrangement.

            Writing `authorizerChain` here yourself takes precedence and fixes
            the order of a multi-link chain; an assertion checks that
            {option}`authorizerName` still appears in it.
          '';
        };

        configFile = lib.mkOption {
          type = lib.types.nullOr lib.types.attrs;
          internal = true;
          readOnly = true;
          description = ''
            The rendered permission-system config, or null when the link is not
            being written. Exposed so a test can assert on the file's contents
            rather than on the Nix that produces it — registration without an
            `authorizerChain` entry is inert, and inert reads exactly like
            working.
          '';
        };
      };

      settings = lib.mkOption {
        type = lib.types.attrs;
        internal = true;
        readOnly = true;
        description = "The rendered pi-automode settings, before serialisation.";
      };

      configFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        internal = true;
        readOnly = true;
        description = ''
          The store file whose contents the launcher exports as
          PI_AUTOMODE_SETTINGS_JSON.
        '';
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

      dismissOnResolve = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Close the `needs_input` notification once the permission ask has been
          answered, rather than leaving it up until it times out. It is raised
          at critical urgency, which on most Linux desktops means it never
          times out at all.

          Driven by pi-permission-system's `permissions:decision` broadcast,
          correlated to the prompt by `requestId`. A prompt from any other
          source carries no request id and is left alone.
        '';
      };

      dismisserCommand = lib.mkOption {
        type = lib.types.str;
        default = if pkgs.stdenv.hostPlatform.isDarwin then "" else "${pkgs.glib.bin}/bin/gdbus";
        defaultText = lib.literalExpression ''
          if pkgs.stdenv.hostPlatform.isDarwin then "" else "''${pkgs.glib.bin}/bin/gdbus"
        '';
        description = ''
          Absolute path to the D-Bus client that closes a notify-send
          notification, resolved at build time for the same reason
          `notifierCommand` is. `org.freedesktop.Notifications.CloseNotification`
          is a D-Bus method with no CLI of its own, so without a client here a
          notify-send notification is left to time out.

          Unused by the `terminal-notifier` and `osascript` styles:
          terminal-notifier removes by group through its own binary, and
          Notification Center exposes no way to close an osascript notification
          at all. Empty is the correct value on Darwin.
        '';
      };

      configFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        internal = true;
        readOnly = true;
        description = "Rendered config handed to pi-notify as PI_NOTIFY_CONFIG.";
      };
    };

    extras = {
      enable = lib.mkEnableOption ''
        prompt stash, chord keybindings, registers and session shortcuts.

        A first-party extension covering what @mrclrchtr/supi-extras and
        @pi-unipi/input-shortcuts each provide: /exit, /clear, /clone-session
        and a /stash overlay, a persistent prompt stash with ten numbered
        registers, undo and redo over the input, clipboard copy and cut, a
        thinking-level cycle, and a terminal tab title that shows when the
        agent is working.

        It deliberately draws no status line of its own. Both upstreams render
        a footer, and this stack already has one
      '';

      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.ext-pi-extras;
        defaultText = lib.literalExpression "pi-nix's packages.ext-pi-extras";
        description = "The extension providing the stash, chords and shortcuts.";
      };

      clipboardCommand = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default =
          if pkgs.stdenv.hostPlatform.isDarwin then
            "${pkgs.pbcopy or pkgs.coreutils}/bin/pbcopy"
          else
            "${pkgs.wl-clipboard}/bin/wl-copy";
        defaultText = lib.literalExpression ''"''${pkgs.wl-clipboard}/bin/wl-copy", or pbcopy on darwin'';
        description = ''
          The command that receives copied text, run OUTSIDE the jail.

          The text crosses the boundary through jail.nix's
          `jail-to-host-channel`: one named program inside the jail whose
          argument is piped to this command outside it. No compositor socket is
          bound and no `WAYLAND_DISPLAY` is forwarded.

          That matters twice over. jail.nix's `wayland` combinator hard-fails,
          because `fwd-env` exits non-zero on an unset variable and `readonly`
          errors on a missing path, so binding the socket would stop pi starting
          on a TTY, over SSH, or on any host with no compositor. And a live
          compositor connection is far more authority than copying a line of
          text needs.

          Set to null to drop the copy and cut chords entirely; the extension
          treats an absent clipboard as an ordinary state rather than an error.
        '';
      };

      gitEditorCommand = lib.mkOption {
        type = lib.types.str;
        default = "${pkgs.coreutils}/bin/true";
        defaultText = lib.literalExpression ''"''${pkgs.coreutils}/bin/true"'';
        description = ''
          What GIT_EDITOR and EDITOR are set to for commands the agent runs.

          A git command that opens an editor waits for a human who is not
          there, and the session hangs until it is killed. `true` exits zero
          immediately, which makes git take the message it already has instead
          of blocking.
        '';
      };
    };

    foreignSkills = {
      enable = lib.mkEnableOption ''
        loading skills from another agent's directory layout.

        pi reads skills from `~/.pi/agent/skills`, `~/.agents/skills`,
        `.pi/skills`, and `.agents/skills` walking up from the cwd. A
        `.claude/skills` directory is none of those, and `settings.json` cannot
        add one: entries in its `skills` array are enable/disable patterns and
        must start with `!`, `+` or `-` (package-manager.js's
        `getOverridePatterns` discards the rest), so a plain path there is
        dropped without a diagnostic. `packages` is the only settings key that
        adds a source and it is global, which cannot express "wherever pi was
        launched".

        This extension answers pi's `resources_discover` event, which carries
        the cwd and takes skill paths back, so the directory is found for the
        session that needs it and for no other
      '';

      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.ext-pi-foreign-skills;
        defaultText = lib.literalExpression "pi-nix's packages.ext-pi-foreign-skills";
        description = "The extension providing foreign skill discovery.";
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

    voice = lib.mkOption {
      default = { };
      description = ''
        Dictation through the first-party pi-voice extension, which drives
        `audiomemo record --stream` and pastes what it hears into the editor.

        Every decision about devices, backends, formats, and secrets stays in
        audiomemo. This option surface is the wiring: which binary, which
        device, and which files the sandbox has to be able to reach.
      '';
      type = lib.types.submodule (
        { config, ... }:
        {
          options = {
            enable = lib.mkEnableOption "pi-voice dictation";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${system}.ext-pi-voice;
              defaultText = lib.literalExpression "pi-nix's packages.ext-pi-voice";
              description = ''
                The pi-voice extension package. Must satisfy the mkPiExtension
                passthru contract.
              '';
            };

            audiomemo = lib.mkOption {
              type = lib.types.package;
              description = ''
                The audiomemo package providing `record`. Its runtime closure
                carries ffmpeg, so binding that closure is what makes recording
                possible inside the jail.

                There is deliberately no default. The jail binds the closure of
                the exact derivation named here, so guessing would produce a
                sandbox whose microphone silently lists no devices.
              '';
            };

            device = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "mic";
              description = ''
                Device alias, group, or raw name passed as `-D`. Null uses
                `record.device` from audiomemo's own config, which is where
                that decision belongs. But audiomemo's picker is an interactive
                TUI and `--stream` is headless, so a machine with no configured
                default wants a name here.
              '';
            };

            extraArgs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              example = [ "--temp" ];
              description = ''
                Further arguments for `record`. `--stream` and `-t` are always
                passed by the extension and cannot be removed here.
              '';
            };

            barWidth = lib.mkOption {
              type = lib.types.ints.between 1 64;
              default = 12;
              description = "Width of the VU bar, in terminal cells.";
            };

            placement = lib.mkOption {
              type = lib.types.enum [
                "aboveEditor"
                "belowEditor"
              ];
              default = "belowEditor";
              description = "Where the voice widget sits relative to the input editor.";
            };

            keyFiles = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              example = lib.literalExpression ''
                {
                  ELEVENLABS_API_KEY_FILE = "/run/agenix/elevenlabs_api_key";
                  DEEPGRAM_API_KEY_FILE = "/run/agenix/deepgram_api_key";
                }
              '';
              description = ''
                Paths to files holding API keys, exported as `*_API_KEY_FILE`.
                audiomemo opens the files itself, so no secret enters the store
                or any process environment. Each path is also bound read-only
                into the jail.

                Recognised names: ELEVENLABS_API_KEY_FILE,
                DEEPGRAM_API_KEY_FILE, OPENAI_API_KEY_FILE,
                MISTRAL_API_KEY_FILE, HF_TOKEN_FILE. An unset variable reads as
                "this backend is unconfigured", which is the right answer for a
                machine with no such key.
              '';
            };

            configFile = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "/home/joe/.config/audiomemo/config.toml";
              description = ''
                audiomemo's config file, used to build the jail's read bind.
                jail.nix's base permission puts a tmpfs over $HOME, so without
                this the file is absent, `record` decides it needs onboarding,
                and it dies opening /dev/tty. Not an optional nicety.
              '';
            };

            jailPermissions = lib.mkOption {
              type = lib.types.functionTo (lib.types.listOf lib.types.raw);
              readOnly = true;
              default =
                combinators:
                lib.optionals config.enable (
                  [
                    # Measured on 2026-08-18, not assumed: with the PulseAudio
                    # socket bound, `audiomemo record -L` inside a jail-shaped
                    # bwrap lists every device and ffmpeg captures audio.
                    # Without it the list is empty and the exit status is zero,
                    # which is the same silent-empty failure the design already
                    # documents for API keys. /dev/snd is not needed: audiomemo
                    # shells to `ffmpeg -f pulse` and never touches ALSA.
                    #
                    # Hand-rolled rather than `combinators.pulse` and
                    # `combinators.pipewire`, and only because both open with
                    # `fwd-env "XDG_RUNTIME_DIR"`, which EXITS NON-ZERO when the
                    # variable is unset. That variable is a desktop session's,
                    # so with those combinators pi refuses to start over SSH, on
                    # a TTY, or anywhere else without one. Voice is a feature to
                    # lose on such a host, not a reason to have no agent.
                    #
                    # The bodies are otherwise copied from those two: the same
                    # four binds, all already `--bind-try`, so an absent socket
                    # was never the problem. Only the environment forwarding is
                    # changed, from hard to `try-`, and the two runtime-dir binds
                    # are wrapped in the shell's `${VAR+...}` so they are emitted
                    # only when there is a runtime dir to interpolate. Without
                    # that guard they would expand to a bare "/pipewire-0" on a
                    # headless host and bind a path nobody meant.
                    (combinators.try-fwd-env "XDG_RUNTIME_DIR")
                    (combinators.try-fwd-env "PULSE_SERVER")
                    (combinators.unsafe-add-raw-args "--bind-try /run/pulse /run/pulse")
                    (combinators.unsafe-add-raw-args "--bind-try /run/pipewire /run/pipewire")
                    (combinators.unsafe-add-raw-args "\${XDG_RUNTIME_DIR+--bind-try \"$XDG_RUNTIME_DIR/pulse\" \"$XDG_RUNTIME_DIR/pulse\"}")
                    (combinators.unsafe-add-raw-args "\${XDG_RUNTIME_DIR+--bind-try \"$XDG_RUNTIME_DIR/pipewire-0\" \"$XDG_RUNTIME_DIR/pipewire-0\"}")
                    (combinators.add-pkg-deps [ config.audiomemo ])
                  ]
                  ++ lib.optional (config.configFile != null) (combinators.try-readonly config.configFile)
                  ++ map combinators.try-readonly (lib.attrValues config.keyFiles)
                );
              description = ''
                The permissions this option needs from jail.nix, exposed so a
                consumer who replaces `jail.permissions` outright can splice
                them back in:

                  jail.permissions = c:
                    (with c; [ network mount-cwd ])
                    ++ config.programs.pi.coding-agent.voice.jailPermissions c;

                A consumer who leaves `jail.permissions` alone, or defines it
                with mkDefault, needs none of this: the module's own default
                already carries these entries and function-typed list options
                merge by concatenation.
              '';
            };
          };
        }
      );
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

    autoMode.settings = autoModeSettings;
    autoMode.configFile = autoModeConfigFile;
    autoMode.permissionSystem.configFile = if chainActive then permissionSystemSettings else null;
    notifications.configFile = notifyConfigFile;

    environment = lib.mkIf (extraEnv != { }) extraEnv;

    extensions =
      # Auto mode first, deliberately: see the permissionSystemPnames comment.
      # Its handler has to see the tool call before the permission system turns
      # it into an ask, so the chain link reviews the real input.
      autoModeEntrypoints
      ++ extEntrypoints
      ++ notificationEntrypoints
      ++ messagingEntrypoints
      ++ voiceEntrypoints
      ++ foreignSkillsEntrypoints
      ++ extrasEntrypoints;
    skills = extSkills ++ messagingSkills;
    promptTemplates = extPrompts;
    settings = extSettings;
  };
}
