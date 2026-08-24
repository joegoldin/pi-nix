{
  lib,
  self,
}:
{
  pkgs,
  extension,
  modules ? [ ],
  extraSpecialArgs ? { },
}:
let
  system = pkgs.stdenv.hostPlatform.system;
  package = self.packages.${system}.coding-agent-bun;
  source = self.packages.${system}.coding-agent-source;
  piSource = source;
  intercom = self.packages.${system}.ext-pi-intercom;

  fail = message: throw "mkAgentContainerBundle: ${message}";

  isCanonicalRelativePath =
    value:
    lib.isString value
    && value != ""
    && !(lib.hasPrefix "/" value)
    && builtins.match "^[A-Za-z0-9_@+.-]+(/[A-Za-z0-9_@+.-]+)*$" value != null
    && lib.all (part: part != "." && part != "..") (lib.splitString "/" value);

  extensionContract =
    extension.passthru.agentContainer or (fail "extension lacks passthru.agentContainer");
  extensionEntrypoint =
    if !(extensionContract ? entrypoint) then
      fail "extension passthru.agentContainer lacks entrypoint"
    else if !isCanonicalRelativePath extensionContract.entrypoint then
      fail "extension passthru.agentContainer.entrypoint is not a canonical relative path"
    else
      extensionContract.entrypoint;
  extensionEntrypointPath = "${extension}/${extensionEntrypoint}";

  intercomContract =
    intercom.passthru.agentContainer or (fail "pi-intercom lacks agentContainer authorities");
  requiredProtocolSources = [
    "broker"
    "client"
    "framing"
    "packageJson"
    "paths"
    "protocol"
    "types"
  ];
  intercomProtocolSources = intercomContract.protocolSources or { };
  intercomContractValid =
    isCanonicalRelativePath (intercomContract.entrypoint or null)
    && isCanonicalRelativePath (intercomContract.brokerEntrypoint or null)
    && builtins.attrNames intercomProtocolSources == requiredProtocolSources
    && lib.all isCanonicalRelativePath (builtins.attrValues intercomProtocolSources);

  extensionForPi = extension // {
    passthru = (extension.passthru or { }) // {
      piEntrypoint = [ extensionEntrypointPath ];
    };
  };

  evaluated = self.lib.mkCodingAgent {
    inherit pkgs extraSpecialArgs;
    modules = modules ++ [
      {
        pi.coding-agent = {
          extensionPackages = lib.mkAfter [ extensionForPi ];
          jail.enable = lib.mkOverride 0 false;
          messaging = {
            enable = lib.mkOverride 0 true;
            package = lib.mkOverride 0 intercom;
            inboundTrigger = lib.mkOverride 0 "replies";
          };
        };
      }
    ];
  };
  cfg = evaluated.config.pi.coding-agent;

  resourceFlagNames = [
    "-e"
    "--append-system-prompt"
    "--extension"
    "--prompt-template"
    "--skill"
    "--system-prompt"
    "--theme"
  ];
  stableValueFlagNames = [
    "--provider"
    "--model"
    "--models"
    "--tools"
    "-t"
    "--exclude-tools"
    "-xt"
    "--thinking"
    "--use-theme"
  ];
  stableBooleanFlagNames = [
    "--no-tools"
    "-nt"
    "--no-builtin-tools"
    "-nbt"
    "--offline"
  ];
  validStableValue =
    flag: value:
    lib.isString value
    && value != ""
    && !(lib.hasPrefix "-" value)
    && (
      flag != "--thinking"
      || lib.elem value [
        "off"
        "minimal"
        "low"
        "medium"
        "high"
        "xhigh"
        "max"
      ]
    );
  canonicalResourceFlag = flag: if flag == "-e" then "--extension" else flag;
  parseInvocationArguments =
    args:
    if args == [ ] then
      {
        resourceEntries = [ ];
        violations = [ ];
      }
    else
      let
        current = toString (builtins.head args);
        rest = builtins.tail args;
        consumeValue =
          resource: valueIsValid:
          if rest == [ ] then
            {
              resourceEntries = [ ];
              violations = [ current ];
            }
          else
            let
              value = builtins.head rest;
              parsed = parseInvocationArguments (builtins.tail rest);
            in
            {
              resourceEntries =
                lib.optional resource {
                  flag = canonicalResourceFlag current;
                  path = value;
                }
                ++ parsed.resourceEntries;
              violations = lib.optional (!(valueIsValid value)) current ++ parsed.violations;
            };
        parsedRest = parseInvocationArguments rest;
      in
      if lib.elem current resourceFlagNames then
        consumeValue true (_: true)
      else if lib.elem current stableValueFlagNames then
        consumeValue false (validStableValue current)
      else if lib.elem current stableBooleanFlagNames then
        parsedRest
      else
        {
          inherit (parsedRest) resourceEntries;
          violations = [ current ] ++ parsedRest.violations;
        };
  parsedInvocationArguments = parseInvocationArguments evaluated.args;
  resourceArgumentEntries = parsedInvocationArguments.resourceEntries;
  invocationArgumentViolations = parsedInvocationArguments.violations;
  resourceArgumentPaths = lib.unique (map (entry: entry.path) resourceArgumentEntries);
  extensionArgumentPaths = map (entry: entry.path) (
    lib.filter (entry: entry.flag == "--extension") resourceArgumentEntries
  );
  requiredExtensionEntrypoints = [ extensionEntrypointPath ] ++ intercom.passthru.piEntrypoint;
  missingRequiredExtensionEntrypoints = lib.filter (
    entrypoint: !(lib.elem entrypoint extensionArgumentPaths)
  ) requiredExtensionEntrypoints;
  missingConfiguredExtensionEntrypoints = lib.filter (
    entrypoint: !(lib.elem entrypoint cfg.extensions)
  ) requiredExtensionEntrypoints;
  forbiddenInvocationFlags = [
    "-ne"
    "--no-extensions"
  ];
  forbiddenInvocationArguments = lib.filter (
    argument: lib.elem argument forbiddenInvocationFlags
  ) evaluated.args;
  adapterOwnedInvocationFlags = [
    "--continue"
    "-c"
    "--resume"
    "-r"
    "--session"
    "--session-id"
    "--fork"
    "--session-dir"
    "--no-session"
    "--name"
    "-n"
    "--export"
    "--approve"
    "-a"
    "--no-approve"
    "-na"
  ];
  matchesInvocationFlag =
    flag: argument: argument == flag || (lib.hasPrefix "--" flag && lib.hasPrefix "${flag}=" argument);
  forbiddenAdapterOwnedArguments = lib.filter (
    argument: lib.any (flag: matchesInvocationFlag flag argument) adapterOwnedInvocationFlags
  ) evaluated.args;
  forbiddenFileArguments = lib.filter (lib.hasPrefix "@") evaluated.args;

  unwrapDefinition =
    value:
    if lib.isDerivation value || !lib.isAttrs value || !(value ? _type) then
      [ value ]
    else if value._type == "merge" then
      lib.concatMap unwrapDefinition value.contents
    else if value._type == "if" then
      lib.optionals value.condition (unwrapDefinition value.content)
    else if value._type == "override" || value._type == "order" then
      unwrapDefinition value.content
    else if value._type == "definition" then
      unwrapDefinition value.value
    else
      [ value ];

  valuesAt =
    path: value:
    lib.concatMap (
      unwrapped:
      if path == [ ] then
        [ unwrapped ]
      else if
        lib.isAttrs unwrapped && !lib.isDerivation unwrapped && unwrapped ? ${builtins.head path}
      then
        valuesAt (builtins.tail path) unwrapped.${builtins.head path}
      else
        [ ]
    ) (unwrapDefinition value);

  actualSpecialArgs = evaluated.moduleProvenance.specialArgs;
  auditModuleArgs = {
    inherit lib;
    inherit (evaluated.moduleProvenance) config options;
    specialArgs = actualSpecialArgs;
    _class = null;
    _prefix = [ ];
  }
  // actualSpecialArgs;

  loadAuditModule =
    fallbackFile: fallbackKey: module:
    if lib.isFunction module then
      lib.modules.unifyModuleSyntax fallbackFile fallbackKey (
        lib.modules.applyModuleArgsIfFunction fallbackKey module auditModuleArgs
      )
    else if lib.isAttrs module then
      if module._type or "module" == "module" then
        lib.modules.unifyModuleSyntax fallbackFile fallbackKey module
      else if module._type == "if" || module._type == "override" then
        loadAuditModule fallbackFile fallbackKey { config = module; }
      else
        fail "module provenance contains an unsupported module value"
    else if lib.isList module then
      fail "module provenance contains a nested module list"
    else
      let
        modulePath = toString module;
      in
      lib.modules.unifyModuleSyntax modulePath modulePath (
        lib.modules.applyModuleArgsIfFunction modulePath (import module) auditModuleArgs
      );
  maxAuditImportDepth = 128;
  collectRawModules =
    parentFile: parentKey: depth: initialModules:
    lib.concatLists (
      lib.imap1 (
        index: module:
        let
          fallbackKey = "${parentKey}:anon-${toString index}";
          loaded = loadAuditModule parentFile fallbackKey module;
        in
        if depth >= maxAuditImportDepth && loaded.imports != [ ] then
          fail "module provenance import depth exceeds the fixed limit"
        else
          [ loaded ] ++ collectRawModules loaded._file loaded.key (depth + 1) loaded.imports
      ) initialModules
    );
  collectedModules = collectRawModules "<unknown-file>" "" 0 evaluated.moduleProvenance.modules;
  rawCodingAgentDefinitions = lib.concatMap (
    module:
    valuesAt [
      "pi"
      "coding-agent"
    ] module.config
  ) collectedModules;

  safeEnvironmentNames = [ "PI_INTERCOM_ASK_TIMEOUT_MS" ];
  isSafeEnvironmentValue =
    name: value:
    name == "PI_INTERCOM_ASK_TIMEOUT_MS"
    && lib.isAttrs value
    && builtins.attrNames value == [ "value" ]
    && lib.isString value.value
    && builtins.match "^(0|[1-9][0-9]*)$" value.value != null;

  environmentViolations =
    value:
    if value == null then
      [ ]
    else if !lib.isAttrs value || lib.isDerivation value then
      [ "environment" ]
    else
      lib.concatMap (
        name:
        lib.optional (
          value.${name} != null
          && !(lib.elem name safeEnvironmentNames && isSafeEnvironmentValue name value.${name})
        ) "environment.${name}"
      ) (builtins.attrNames value);

  lowerName = name: lib.toLower (lib.replaceStrings [ "_" "-" ] [ "" "" ] name);
  isCredentialName =
    name:
    builtins.match ".*(apikey|token|credential|secret|password|authorization|keyfile).*" (
      lowerName name
    ) != null;
  hasProviderOrModelAncestor =
    path:
    lib.any (
      name:
      lib.elem (lowerName name) [
        "provider"
        "providers"
        "model"
        "models"
      ]
    ) path;

  definitionViolations =
    path: value:
    if path == [ "environment" ] then
      environmentViolations value
    else if path == [ "models" ] && value != null then
      [ "models" ]
    else if lib.isDerivation value then
      if path == [ "extensionPackages" ] then extensionPackageViolations value else [ ]
    else if builtins.isPath value || lib.isFunction value then
      [ ]
    else if lib.isList value then
      lib.concatMap (definitionViolations path) value
    else if lib.isAttrs value then
      lib.concatMap (
        name:
        let
          nextPath = path ++ [ name ];
          lower = lowerName name;
          forbiddenName =
            isCredentialName name
            || (
              path == [ "settings" ]
              && (
                (lib.elem name forbiddenSettingsNames && value.${name} != null)
                || (lib.elem name dynamicSettingsNames && !(isEmptyDynamicSettingsValue value.${name}))
                || (name == "defaultProjectTrust" && value.${name} != null && value.${name} != "never")
              )
            )
            || (
              hasProviderOrModelAncestor path
              && lib.elem lower [
                "command"
                "file"
                "path"
              ]
            );
        in
        lib.optional forbiddenName (lib.concatStringsSep "." nextPath)
        ++ definitionViolations nextPath value.${name}
      ) (builtins.attrNames value)
    else if
      path != [ ]
      && builtins.head path == "extraArgs"
      && lib.isString value
      &&
        builtins.match ".*(api.?key|token|credential|secret|password|authorization).*" (lib.toLower value)
        != null
    then
      [ "extraArgs" ]
    else
      [ ];

  moduleDefinitionViolations =
    value:
    lib.concatMap (
      root:
      if !lib.isAttrs root || lib.isDerivation root then
        definitionViolations [ ] root
      else
        lib.concatMap (
          name: lib.concatMap (definitionViolations [ name ]) (unwrapDefinition root.${name})
        ) (builtins.attrNames root)
    ) (unwrapDefinition value);

  extensionPackageViolations =
    extensionPackage:
    let
      packageSettings = extensionPackage.passthru.settings or { };
      packageConfigFiles = extensionPackage.passthru.configFiles or { };
      invalidConfigPaths = lib.filter (
        relativePath: !(isCanonicalRelativePath relativePath) || isReservedConfigPath relativePath
      ) (builtins.attrNames packageConfigFiles);
    in
    definitionViolations [ "settings" ] packageSettings
    ++ definitionViolations [ "extensionConfigFiles" ] packageConfigFiles
    ++ map (relativePath: "extensionConfigFiles.${relativePath}") invalidConfigPaths;

  rawViolations = lib.concatMap moduleDefinitionViolations rawCodingAgentDefinitions;
  packageSourceViolations =
    extensionPackageViolations extensionForPi
    ++ extensionPackageViolations intercom
    ++ lib.concatMap extensionPackageViolations cfg.extensionPackages;
  effectiveViolations =
    definitionViolations [ "settings" ] cfg.settings
    ++ definitionViolations [ "extensionConfigFiles" ] cfg.finalConfigFiles
    ++ definitionViolations [ "models" ] cfg.models
    ++ environmentViolations cfg.environment;
  dynamicSettingsNames = [
    "extensions"
    "packages"
    "prompts"
    "skills"
    "themes"
  ];
  isEmptyDynamicSettingsValue = value: value == null || (lib.isList value && value == [ ]);
  settingsResourceViolations = lib.concatMap (
    name:
    let
      value = cfg.settings.${name} or null;
      empty = isEmptyDynamicSettingsValue value;
    in
    lib.optional (!empty) "settings.${name}"
  ) dynamicSettingsNames;
  forbiddenSettingsNames = [
    "externalEditor"
    "httpProxy"
    "npmCommand"
    "sessionDir"
    "shellCommandPrefix"
    "shellPath"
  ];
  forbiddenSettingsViolations = lib.concatMap (
    name: lib.optional (cfg.settings.${name} or null != null) "settings.${name}"
  ) forbiddenSettingsNames;
  expectedIntercomConfig = lib.recursiveUpdate intercom.passthru.configFiles."intercom/config.json" {
    brokerCommand = lib.getExe pkgs.bun;
    brokerArgs = [ ];
    inboundTrigger = "replies";
    confirmSend = false;
  };
  messagingPolicyViolations =
    lib.optional (!cfg.messaging.enable) "messaging.enable"
    ++ lib.optional (toString cfg.messaging.package != toString intercom) "messaging.package"
    ++ lib.optional (
      builtins.toJSON cfg.messaging.package.passthru != builtins.toJSON intercom.passthru
    ) "messaging.package.passthru"
    ++ lib.optional (cfg.messaging.inboundTrigger != "replies") "messaging.inboundTrigger"
    ++ lib.optional (
      (cfg.finalConfigFiles."intercom/config.json" or null) != expectedIntercomConfig
    ) "extensionConfigFiles.intercom/config.json";
  allViolations =
    rawViolations
    ++ packageSourceViolations
    ++ effectiveViolations
    ++ settingsResourceViolations
    ++ forbiddenSettingsViolations
    ++ messagingPolicyViolations;

  environment =
    if cfg.environment == null then
      { }
    else
      lib.mapAttrs (_: tagged: tagged.value) (lib.filterAttrs (_: value: value != null) cfg.environment);

  resourcePaths = lib.filter (value: value != null) (
    cfg.extensions
    ++ cfg.skills
    ++ cfg.themes
    ++ cfg.promptTemplates
    ++ [
      evaluated.rules
      cfg.finalSystemPrompt
    ]
    ++ resourceArgumentPaths
  );
  isCanonicalStorePath =
    value:
    let
      string = toString value;
      relative = lib.removePrefix "${builtins.storeDir}/" string;
      parts = lib.splitString "/" relative;
    in
    lib.hasPrefix "${builtins.storeDir}/" string
    && builtins.getContext string != { }
    && parts != [ ]
    && builtins.match "^[0-9abcdfghijklmnpqrsvwxyz]{32}-.+$" (builtins.head parts) != null
    && lib.all (part: part != "" && part != "." && part != "..") parts;
  nonStoreResources = lib.filter (value: !(isCanonicalStorePath value)) resourcePaths;

  json = pkgs.formats.json { };
  safeSettings = cfg.settings // {
    defaultProjectTrust = "never";
  };
  settingsFile = json.generate "agent-container-settings.json" safeSettings;
  policy = import ./agent-container-policy.nix { inherit piSource; };
  argsFile = json.generate "agent-container-args.json" evaluated.args;
  environmentFile = json.generate "agent-container-environment.json" environment;
  modelsFile = json.generate "agent-container-models.json" policy.models;
  policyFile = json.generate "agent-container-policy.json" policy;
  extensionConfigFiles = lib.mapAttrs (
    relativePath: value:
    json.generate "agent-container-${lib.replaceStrings [ "/" ] [ "-" ] relativePath}" value
  ) cfg.finalConfigFiles;
  reservedConfigNames = [
    "agent-container-bundle.json"
    "args.json"
    "auth.json"
    "auth.json.lock"
    "environment.json"
    "models-store.json"
    "models-store.json.lock"
    "models.json"
    "oauth.json"
    "oauth.json.migrated"
    "policy.json"
    "resource-inventory.json"
    "sessions"
    "settings.json"
    "settings.json.lock"
    "trust.json"
    "trust.json.lock"
  ];
  isReservedConfigPath =
    relativePath:
    let
      parts = lib.splitString "/" relativePath;
      root = builtins.head parts;
    in
    lib.elem root reservedConfigNames || (builtins.length parts == 1 && lib.hasSuffix ".jsonl" root);
  configPathViolations = lib.filter (
    relativePath: !(isCanonicalRelativePath relativePath) || isReservedConfigPath relativePath
  ) (builtins.attrNames extensionConfigFiles);

  resources = {
    inherit (cfg)
      extensions
      promptTemplates
      skills
      themes
      ;
    inherit (evaluated) rules;
    systemPrompt = cfg.finalSystemPrompt;
    inherit extensionConfigFiles;
    argumentEntries = resourceArgumentEntries;
    argumentPaths = resourceArgumentPaths;
  };
  resourceInventoryFile = json.generate "agent-container-resource-inventory.json" resources;

  policySourceAuthorities = policy.providers."openai-codex".sourceAuthorities;
  manifestMetadata = {
    version = 1;
    piVersion = (builtins.fromJSON (builtins.readFile ../VERSION.json)).rev;
    piSource = "${piSource}";
    inherit extensionEntrypoint;
    adapterProtocol = 1;
    controlProtocol = 1;
    providerProtocol = 1;
    intercomProtocol = 1;
    inboundTrigger = "replies";
    intercom = {
      package = "${intercom}";
      paths = {
        inherit (intercomContract) entrypoint brokerEntrypoint;
      }
      // intercomProtocolSources;
    };
    policy.version = policy.version;
  };
  manifestMetadataFile = json.generate "agent-container-manifest-metadata.json" manifestMetadata;

  addHashedSources =
    sourceSet: root:
    lib.concatStringsSep "\n" (
      lib.mapAttrsToList (name: relativePath: ''
        authority_path=${lib.escapeShellArg "${root}/${relativePath}"}
        if [ ! -f "$authority_path" ]; then
          echo "agent-container bundle: authority source does not exist" >&2
          exit 1
        fi
        authority_sha="$(${lib.getExe' pkgs.coreutils "sha256sum"} "$authority_path")"
        authority_sha="''${authority_sha%% *}"
        hashed_sources="$(${lib.getExe pkgs.jq} \
          --arg name ${lib.escapeShellArg name} \
          --arg path "$authority_path" \
          --arg sha256 "$authority_sha" \
          '. + {($name): {path: $path, sha256: $sha256}}' \
          <<<"$hashed_sources")"
      '') sourceSet
    );

  manifestFile =
    pkgs.runCommand "agent-container-bundle-manifest.json"
      {
        nativeBuildInputs = [ pkgs.jq ];
      }
      ''
        set -euo pipefail

        extension_root=${lib.escapeShellArg "${extension}"}
        extension_entrypoint=${lib.escapeShellArg extensionEntrypoint}
        if [ ! -f "$extension_root/package.json" ]; then
          echo "agent-container bundle: package.json must declare exactly one Pi extension" >&2
          exit 1
        fi
        if ! declared_entrypoint="$(${lib.getExe pkgs.jq} -er \
          'if (.pi.extensions | type) == "array" and (.pi.extensions | length) == 1 and (.pi.extensions[0] | type) == "string" then .pi.extensions[0] else error("invalid") end' \
          "$extension_root/package.json" 2>/dev/null)"; then
          echo "agent-container bundle: package.json must declare exactly one Pi extension" >&2
          exit 1
        fi
        if [ "$declared_entrypoint" != "./$extension_entrypoint" ]; then
          echo "agent-container bundle: package.json Pi extension does not match passthru.agentContainer.entrypoint" >&2
          exit 1
        fi
        if [ ! -f "$extension_root/$extension_entrypoint" ]; then
          echo "agent-container bundle: declared Pi extension leaf does not exist" >&2
          exit 1
        fi

        intercom_root=${lib.escapeShellArg "${intercom}"}
        intercom_entrypoint=${lib.escapeShellArg intercomContract.entrypoint}
        intercom_broker_entrypoint=${lib.escapeShellArg intercomContract.brokerEntrypoint}
        if [ ! -f "$intercom_root/$intercom_entrypoint" ] || [ ! -f "$intercom_root/$intercom_broker_entrypoint" ]; then
          echo "agent-container bundle: pi-intercom authority entrypoint does not exist" >&2
          exit 1
        fi
        intercom_version="$(${lib.getExe pkgs.jq} -er '.version | select(type == "string" and length > 0)' "$intercom_root/package.json")"

        hashed_sources='{}'
        ${addHashedSources intercomProtocolSources intercom}
        intercom_protocol_sources="$hashed_sources"

        hashed_sources='{}'
        ${addHashedSources {
          inherit (intercomContract) entrypoint brokerEntrypoint;
        } intercom}
        intercom_entrypoints="$hashed_sources"
        intercom_sha256="$(${lib.getExe pkgs.jq} -n \
          --argjson protocolSources "$intercom_protocol_sources" \
          --argjson entrypoints "$intercom_entrypoints" \
          '$protocolSources + $entrypoints | map_values(.sha256)')"

        hashed_sources='{}'
        ${addHashedSources {
          packageJson = "package.json";
          entrypoint = extensionEntrypoint;
        } extension}
        extension_sources="$hashed_sources"
        extension_paths="$(${lib.getExe pkgs.jq} 'map_values(.path)' <<<"$extension_sources")"
        extension_sha256="$(${lib.getExe pkgs.jq} 'map_values(.sha256)' <<<"$extension_sources")"

        hashed_sources='{}'
        ${addHashedSources (lib.mapAttrs (
          _: authority: authority.relativePath
        ) policySourceAuthorities) piSource}
        policy_sources="$hashed_sources"

        ${lib.getExe pkgs.jq} \
          --arg intercomVersion "$intercom_version" \
          --argjson intercomSha256 "$intercom_sha256" \
          --argjson extensionPaths "$extension_paths" \
          --argjson extensionSha256 "$extension_sha256" \
          --argjson policySources "$policy_sources" \
          '.
            + {intercom: (.intercom + {
                packageVersion: $intercomVersion,
                sha256: $intercomSha256
              })}
            + {extension: {
                paths: $extensionPaths,
                sha256: $extensionSha256
              }}
            + {policy: (.policy + {sourceAuthorities: $policySources})}
          ' ${manifestMetadataFile} > "$out"
      '';

  configTree = pkgs.runCommand "agent-container-pi-config" { } ''
    set -euo pipefail

    mkdir -p "$out"
    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (relativePath: source: ''
        mkdir -p "$out/$(dirname ${lib.escapeShellArg relativePath})"
        install -m 0444 ${source} "$out/${relativePath}"
      '') extensionConfigFiles
    )}
    install -m 0444 ${argsFile} "$out/args.json"
    install -m 0444 ${environmentFile} "$out/environment.json"
    install -m 0444 ${settingsFile} "$out/settings.json"
    install -m 0444 ${modelsFile} "$out/models.json"
    install -m 0444 ${policyFile} "$out/policy.json"
    install -m 0444 ${resourceInventoryFile} "$out/resource-inventory.json"
    install -m 0444 ${manifestFile} "$out/agent-container-bundle.json"
  '';

  runtimeInputs = lib.unique (
    [
      package
      extension
      intercom
      configTree
    ]
    ++ cfg.messagingRuntimeInputs
    ++ resourcePaths
    ++ builtins.attrValues extensionConfigFiles
  );
  runtimeBundle = pkgs.symlinkJoin {
    name = "pi-agent-container-runtime-bundle";
    paths = [
      package
      configTree
    ];
    postBuild = ''
      mkdir -p "$out/runtime-inputs"
      ${lib.concatStringsSep "\n" (
        lib.imap0 (index: input: ''
          runtime_input=${lib.escapeShellArg (toString input)}
          if [ ! -e "$runtime_input" ]; then
            echo "agent-container bundle: runtime input does not exist" >&2
            exit 1
          fi
          resolved_input="$(readlink -f -- "$runtime_input")"
          case "$resolved_input" in
            ${builtins.storeDir}/*) ;;
            *)
              echo "agent-container bundle: runtime input resolves outside the store" >&2
              exit 1
              ;;
          esac
          ln -s "$runtime_input" "$out/runtime-inputs/${toString index}"
        '') runtimeInputs
      )}
    '';
  };
in
if !intercomContractValid then
  fail "pi-intercom agentContainer authorities are malformed"
else if missingRequiredExtensionEntrypoints != [ ] then
  fail "required extension entrypoints are absent from the Pi invocation"
else if missingConfiguredExtensionEntrypoints != [ ] then
  fail "required extension entrypoints are absent from the evaluated Pi resources"
else if forbiddenInvocationArguments != [ ] then
  fail "required extensions cannot be disabled"
else if forbiddenAdapterOwnedArguments != [ ] then
  fail "session and trust arguments are owned by the runtime adapter"
else if forbiddenFileArguments != [ ] then
  fail "runtime file arguments are owned by the runtime adapter"
else if invocationArgumentViolations != [ ] then
  fail "Pi invocation arguments are outside the closed bundle grammar"
else if allViolations != [ ] then
  fail "secret-bearing or non-allowlisted module definition"
else if configPathViolations != [ ] then
  fail "extension config path is non-canonical or reserved"
else if nonStoreResources != [ ] then
  fail "runtime resources must be immutable store paths"
else
  {
    inherit
      configTree
      environment
      manifestFile
      manifestMetadata
      package
      piSource
      policy
      resources
      runtimeBundle
      runtimeInputs
      source
      ;
    inherit (evaluated) args;
  }
