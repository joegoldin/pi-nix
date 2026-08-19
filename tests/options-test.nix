# Module tests are pure evaluation: build the same module list mkCodingAgent
# builds, then assert on finalArgs. `self` is stubbed so the test does not
# need the real coding-agent closure to check argument construction.
{ pkgs, self, ... }:
let
  lib = pkgs.lib;
  system = pkgs.stdenv.hostPlatform.system;

  statuslineLib = self.inputs.agent-statusline.lib.${system};

  selfStub = {
    packages.${system} = {
      coding-agent = pkgs.hello;
      # Distinguishable from coding-agent so the default-package assertion
      # below cannot pass by accident.
      coding-agent-bun = pkgs.cowsay;
      inherit (self.packages.${system}) ext-pi-auto-mode ext-pi-notify ext-pi-voice;
    };
    inputs.agent-statusline = self.inputs.agent-statusline;
  };

  evalPi =
    module:
    (lib.evalModules {
      specialArgs = {
        self = selfStub;
        inherit pkgs;
      };
      modules = [
        (import ../coding-agent/options.nix {
          self = selfStub;
          jail-nix = null;
        })
        (import ../coding-agent/extra-options.nix {
          self = selfStub;
        })
        module
      ];
    }).config.pi.coding-agent;

  argPair =
    args: flag:
    let
      idx = lib.lists.findFirstIndex (a: a == flag) null args;
    in
    if idx == null then null else builtins.elemAt args (idx + 1);

  # ── unset ────────────────────────────────────────────────────────────────
  bare = evalPi { };

  # ── inline text ──────────────────────────────────────────────────────────
  inline = evalPi { pi.coding-agent.systemPrompt = "You are terse.\n"; };

  # ── coexisting with upstream's rules ─────────────────────────────────────
  both = evalPi {
    pi.coding-agent = {
      systemPrompt = "Replacement prompt.\n";
      rules = "Appended preferences.\n";
    };
  };

  # ── user extraArgs must survive ──────────────────────────────────────────
  withExtra = evalPi {
    pi.coding-agent = {
      systemPrompt = "Replacement prompt.\n";
      extraArgs = [
        "--provider"
        "openai"
      ];
    };
  };

  fakeExt =
    name: passthru:
    (pkgs.runCommand "fake-pi-ext-${name}" { } ''
      mkdir -p $out/skills $out/prompts
      touch $out/index.ts
    '').overrideAttrs
      (old: {
        passthru = (old.passthru or { }) // passthru;
      });

  extA = fakeExt "a" {
    piEntrypoint = [ "/nix/store/fake-a" ];
    piSkills = [ "/nix/store/fake-a/skills" ];
    piPrompts = [ ];
    settings = {
      alpha = true;
      shared.fromA = 1;
    };
    promptFragment = null;
  };

  extB = fakeExt "b" {
    piEntrypoint = [
      "/nix/store/fake-b/one.ts"
      "/nix/store/fake-b/two.ts"
    ];
    piSkills = [ ];
    piPrompts = [ "/nix/store/fake-b/prompts" ];
    settings = {
      beta = 2;
      shared.fromB = 2;
    };
    promptFragment = "Use the beta tool when beta-ing.";
  };

  withExts = evalPi {
    pi.coding-agent.extensionPackages = [
      extA
      extB
    ];
  };

  flagValues =
    args: flag:
    let
      indexed = lib.imap0 (i: a: { inherit i a; }) args;
    in
    map (e: builtins.elemAt args (e.i + 1)) (lib.filter (e: e.a == flag) indexed);

  slOff = evalPi { };

  slOn = evalPi {
    pi.coding-agent.statusline = {
      enable = true;
      padding = 2;
    };
  };

  envValue =
    c: name:
    let
      e = c.environment;
    in
    if e == null then null else (e.${name} or null);

  notifyExt = fakeExt "notify" {
    piEntrypoint = [ "/nix/store/fake-notify/index.ts" ];
    piSkills = [ ];
    piPrompts = [ ];
    settings = { };
    promptFragment = null;
  };

  notifyOff = evalPi { };

  notifyOn = evalPi {
    pi.coding-agent.notifications = {
      enable = true;
      package = notifyExt;
      events = [
        "settled"
        "needs_input"
      ];
      longRunningToolSeconds = 45;
    };
  };

  # unsafeDiscardStringContext because the rendered notifier is a store path and
  # fromJSON refuses a string carrying context.
  notifyJson = builtins.fromJSON (
    builtins.unsafeDiscardStringContext (builtins.readFile notifyOn.notifications.configFile)
  );

  # The option default is the real first-party extension, so `enable = true`
  # alone must be enough.
  notifyDefaults = evalPi { pi.coding-agent.notifications.enable = true; };

  autoOff = evalPi { };

  autoOn = evalPi {
    pi.coding-agent.autoMode = {
      enable = true;
      allow = [ "reading anything under the working directory" ];
      soft_deny = [ "deleting files the user did not name" ];
      hard_deny = [ "reading private SSH keys" ];
      environment = [ "this is a NixOS machine" ];
      deterministic = {
        allow = [ "Bash(git status:*)" ];
        deny = [ "Bash(curl:*)" ];
      };
      model = {
        provider = "anthropic";
        modelId = "claude-haiku-4-5";
      };
      userTurnLimit = 3;
      timeoutMs = 5000;
    };
  };

  autoJson = builtins.fromJSON (builtins.readFile autoOn.autoMode.configFile);

  # A stand-in for jail.nix's combinator set, so the permission list can be
  # asserted without building a jail.
  fakeCombinators = {
    pulse = "pulse";
    pipewire = "pipewire";
    network = "network";
    mount-cwd = "mount-cwd";
    notifications = "notifications";
    noescape = p: p;
    try-readonly = p: "try-readonly:${p}";
    try-readwrite = p: "try-readwrite:${p}";
    try-fwd-env = v: "try-fwd-env:${v}";
    add-pkg-deps = ps: "add-pkg-deps:${toString (builtins.length ps)}";
  };

  voiceOff = evalPi { };

  withVoice = evalPi {
    pi.coding-agent.voice = {
      enable = true;
      # pkgs.hello stands in for audiomemo: the assertions are about the shape
      # of the path and of the closure bind, not about ffmpeg.
      audiomemo = pkgs.hello;
      device = "mic";
      keyFiles.ELEVENLABS_API_KEY_FILE = "/run/agenix/elevenlabs_api_key";
      configFile = "/home/joe/.config/audiomemo/config.toml";
    };
  };

  voicePermissions = withVoice.voice.jailPermissions fakeCombinators;

  voiceUnpackaged = builtins.tryEval (
    lib.deepSeq (evalPi { pi.coding-agent.voice.enable = true; }).environment "unreachable"
  );

  notifyUnpackaged = builtins.tryEval (
    lib.deepSeq
      (evalPi {
        pi.coding-agent.notifications = {
          enable = true;
          package = null;
        };
      }).finalArgs
      "unreachable"
  );
in
# The fork ships the Bun build by default. Upstream's option declares
# `default = coding-agent`; a mkDefault from extra-options.nix outranks it
# without options.nix changing.
assert bare.package == pkgs.cowsay;
# An explicit choice still wins, so the npm build stays reachable.
assert (evalPi { pi.coding-agent.package = pkgs.hello; }).package == pkgs.hello;
assert !(lib.elem "--system-prompt" bare.finalArgs);
assert bare.finalSystemPrompt == null;
assert lib.elem "--system-prompt" inline.finalArgs;
assert inline.finalSystemPrompt != null;
assert argPair inline.finalArgs "--system-prompt" == "${inline.finalSystemPrompt}";
# --system-prompt replaces, --append-system-prompt appends; both may be present
# and pi applies them in that order.
assert lib.elem "--system-prompt" both.finalArgs;
assert lib.elem "--append-system-prompt" both.finalArgs;
assert argPair both.finalArgs "--append-system-prompt" == "${both.finalRules}";
assert lib.elem "--provider" withExtra.finalArgs;
assert argPair withExtra.finalArgs "--provider" == "openai";
assert lib.elem "--system-prompt" withExtra.finalArgs;
# Every entrypoint of every enabled extension becomes its own --extension flag.
assert
  flagValues withExts.finalArgs "--extension" == [
    "/nix/store/fake-a"
    "/nix/store/fake-b/one.ts"
    "/nix/store/fake-b/two.ts"
  ];
assert flagValues withExts.finalArgs "--skill" == [ "/nix/store/fake-a/skills" ];
assert flagValues withExts.finalArgs "--prompt-template" == [ "/nix/store/fake-b/prompts" ];
# settings are deep-merged, so two extensions can contribute to one subtree.
assert withExts.settings.alpha == true;
assert withExts.settings.beta == 2;
assert
  withExts.settings.shared == {
    fromA = 1;
    fromB = 2;
  };
# A non-null promptFragment is appended, never used to replace the prompt.
assert lib.length (flagValues withExts.finalArgs "--append-system-prompt") == 1;
# An extension with no fragment contributes nothing at all.
assert
  flagValues (evalPi { pi.coding-agent.extensionPackages = [ extA ]; }).finalArgs
    "--append-system-prompt" == [ ];
# Disabled is inert: no flag, no environment, nothing in the closure.
assert flagValues slOff.finalArgs "--extension" == [ ];
assert envValue slOff "AGENT_STATUSLINE_BIN" == null;
# Enabled adds exactly one --extension, pointing at the extension package root
# so pi resolves entries from its own pi manifest.
assert lib.length (flagValues slOn.finalArgs "--extension") == 1;
assert builtins.head (flagValues slOn.finalArgs "--extension") == "${slOn.statusline.extension}";
assert envValue slOn "AGENT_STATUSLINE_BIN" != null;
assert envValue slOn "AGENT_STATUSLINE_CONFIG" != null;
# The shared schema is mounted verbatim, so every option claude-nix has is here.
assert slOn.statusline.padding == 2;
# Disabled contributes nothing at all.
assert notifyOff.notifications.configFile == null;
assert envValue notifyOff "PI_NOTIFY_CONFIG" == null;
assert !(notifyOff.settings ? piNotify);
# Enabled wires the extension and the config env var.
assert lib.elem "/nix/store/fake-notify/index.ts" (flagValues notifyOn.finalArgs "--extension");
assert envValue notifyOn "PI_NOTIFY_CONFIG" != null;
assert (envValue notifyOn "PI_NOTIFY_CONFIG").value == "${notifyOn.notifications.configFile}";
# Config reaches the extension through the environment, never settings.json:
# pi hands extensions no settings reader, so a piNotify block there would be
# config nothing can read.
assert !(notifyOn.settings ? piNotify);
# The event list becomes the three booleans the extension switches on, and the
# threshold crosses from seconds to milliseconds exactly once.
assert notifyJson.enabled == true;
assert notifyJson.events.agentSettled == true;
assert notifyJson.events.permissionPrompt == true;
assert notifyJson.events.longToolCall == false;
assert notifyJson.longToolCallThresholdMs == 45000;
assert lib.hasPrefix "/nix/store/" notifyJson.notifier;
assert notifyJson.appName == "pi";
# The default package is this flake's own pi-notify, so enable alone works.
assert
  flagValues notifyDefaults.finalArgs "--extension"
  == selfStub.packages.${system}.ext-pi-notify.passthru.piEntrypoint;
# Disabled contributes no extension, no environment, and no config file.
assert autoOff.autoMode.configFile == null;
assert envValue autoOff "PI_AUTO_MODE_CONFIG" == null;
assert !(lib.any (lib.hasInfix "pi-auto-mode") (flagValues autoOff.finalArgs "--extension"));
# Enabled hands pi the entrypoint from the extension's own passthru, so the
# filename inside the package stays that package's business.
assert
  flagValues autoOn.finalArgs "--extension"
  == selfStub.packages.${system}.ext-pi-auto-mode.passthru.piEntrypoint;
# Config travels as a store path in an env var, never in settings.json: pi's
# ExtensionContext has no settings reader.
assert envValue autoOn "PI_AUTO_MODE_CONFIG" != null;
assert (envValue autoOn "PI_AUTO_MODE_CONFIG").value == "${autoOn.autoMode.configFile}";
assert !(autoOn.settings ? piAutoMode);
# Every rule list reaches the rendered JSON under the key the extension reads,
# including the two underscore-cased ones the classifier prompt names verbatim.
assert autoJson.enabled == true;
assert autoJson.allow == [ "reading anything under the working directory" ];
assert autoJson.soft_deny == [ "deleting files the user did not name" ];
assert autoJson.hard_deny == [ "reading private SSH keys" ];
assert autoJson.environment == [ "this is a NixOS machine" ];
assert autoJson.deterministic.allow == [ "Bash(git status:*)" ];
assert autoJson.deterministic.deny == [ "Bash(curl:*)" ];
assert autoJson.classifierModel.provider == "anthropic";
assert autoJson.classifierModel.modelId == "claude-haiku-4-5";
assert autoJson.userTurnLimit == 3;
assert autoJson.timeoutMs == 5000;
assert autoJson.delegateToPermissionSystem == false;
# Enabled without a package must fail loudly rather than silently doing
# nothing, because "notifications are on" and "no notifier exists" is exactly
# the state a user would not notice.
assert notifyUnpackaged.success == false;
# Disabled contributes no extension, no environment, and no permission.
assert !(lib.any (lib.hasInfix "pi-voice") (flagValues voiceOff.finalArgs "--extension"));
assert envValue voiceOff "PI_VOICE_RECORD_BIN" == null;
assert voiceOff.voice.jailPermissions fakeCombinators == [ ];
# Enabled hands pi the entrypoint from the extension's own passthru.
assert lib.elem (builtins.head selfStub.packages.${system}.ext-pi-voice.passthru.piEntrypoint) (
  flagValues withVoice.finalArgs "--extension"
);
# The record binary is an absolute store path, not whatever `record` happens to
# resolve to on a PATH the jail does not provide.
assert lib.hasSuffix "/bin/record" (envValue withVoice "PI_VOICE_RECORD_BIN").value;
assert lib.hasPrefix "/nix/store/" (envValue withVoice "PI_VOICE_RECORD_BIN").value;
assert (envValue withVoice "PI_VOICE_RECORD_ARGS").value == "-D mic";
assert (envValue withVoice "PI_VOICE_BAR_WIDTH").value == "12";
assert (envValue withVoice "PI_VOICE_PLACEMENT").value == "belowEditor";
# Keys travel as paths. A value here would put a secret in the store.
assert (envValue withVoice "ELEVENLABS_API_KEY_FILE").value == "/run/agenix/elevenlabs_api_key";
assert envValue withVoice "ELEVENLABS_API_KEY" == null;
# Without these the microphone is not merely restricted inside the jail: it is
# absent, and audiomemo reports an empty device list with no error.
assert lib.elem "pulse" voicePermissions;
assert lib.elem "pipewire" voicePermissions;
assert lib.elem "add-pkg-deps:1" voicePermissions;
assert lib.elem "try-readonly:/home/joe/.config/audiomemo/config.toml" voicePermissions;
assert lib.elem "try-readonly:/run/agenix/elevenlabs_api_key" voicePermissions;
# The module's own jail default already carries them, so a consumer who never
# touches jail.permissions still gets a working microphone.
assert lib.elem "pulse" (withVoice.jail.permissions fakeCombinators);
assert !(lib.elem "pulse" (voiceOff.jail.permissions fakeCombinators));
# Enabled without an audiomemo package must fail loudly: the jail binds the
# closure of the exact derivation named there, so there is nothing to guess.
assert voiceUnpackaged.success == false;
pkgs.runCommand "pi-nix-options-tests" { } ''
  set -euo pipefail
  # The written prompt must be the literal text, with no wrapper or frontmatter.
  grep -qxF 'You are terse.' ${inline.finalSystemPrompt}
  # renderConfig must emit the padding the option carries, proving the shared
  # schema is actually driving the JSON rather than a default being re-rendered.
  test "$(${pkgs.jq}/bin/jq -r .padding ${statuslineLib.renderConfig slOn.statusline})" = 2
  # The binary the module points at must exist under the package it selected.
  test -x ${slOn.statusline.package}/bin/agent-statusline
  touch $out
''
