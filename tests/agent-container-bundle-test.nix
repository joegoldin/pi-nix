{
  pkgs,
  self,
  ...
}:
let
  inherit (pkgs) lib;
  inherit (pkgs.stdenv.hostPlatform) system;

  mkExtension =
    {
      name,
      packageJson,
      files ? [ "src/index.ts" ],
      entrypoint ? "src/index.ts",
      agentContainer ? true,
    }:
    let
      packageJsonFile = pkgs.writeText "${name}-package.json" (builtins.toJSON packageJson);
      base = pkgs.runCommand name { } ''
        mkdir -p "$out"
        cp ${packageJsonFile} "$out/package.json"
        ${lib.concatMapStringsSep "\n" (file: ''
          mkdir -p "$out/$(dirname ${lib.escapeShellArg file})"
          touch "$out/${file}"
        '') files}
      '';
    in
    base
    // lib.optionalAttrs agentContainer {
      passthru = (base.passthru or { }) // {
        agentContainer = { inherit entrypoint; };
        configFiles."agent-container/config.json" = {
          enabled = true;
          transport = "host";
        };
      };
    };

  validPackageJson = {
    name = "agent-container-pi";
    version = "1.0.0";
    keywords = [ "pi-package" ];
    pi.extensions = [ "./src/index.ts" ];
  };

  fakeExtension = mkExtension {
    name = "agent-container-pi-extension";
    packageJson = validPackageJson;
  };
  intercom = self.packages.${system}.ext-pi-intercom;

  bundle = self.lib.mkAgentContainerBundle {
    inherit pkgs;
    extension = fakeExtension;
  };

  evalBundle =
    modules:
    builtins.tryEval
      (self.lib.mkAgentContainerBundle {
        inherit pkgs modules;
        extension = fakeExtension;
      }).manifestMetadata.version;

  evalExtension =
    extension:
    builtins.tryEval
      (self.lib.mkAgentContainerBundle {
        inherit pkgs extension;
      }).manifestMetadata.version;

  extensionWithConfig =
    relativePath:
    fakeExtension
    // {
      passthru = fakeExtension.passthru // {
        configFiles = fakeExtension.passthru.configFiles // {
          ${relativePath}.hijacked = true;
        };
      };
    };

  secretSettingsExtension = fakeExtension // {
    passthru = fakeExtension.passthru // {
      settings.providers.example.apiKey = "not-a-real-key";
    };
  };

  secretExtensionSettingsOverridden =
    builtins.tryEval
      (self.lib.mkAgentContainerBundle {
        inherit pkgs;
        extension = secretSettingsExtension;
        modules = [
          {
            pi.coding-agent.settings = lib.mkForce { };
          }
        ];
      }).manifestMetadata.version;

  missingContract =
    builtins.tryEval
      (self.lib.mkAgentContainerBundle {
        inherit pkgs;
        extension = mkExtension {
          name = "agent-container-no-contract";
          packageJson = validPackageJson;
          agentContainer = false;
        };
      }).manifestMetadata.version;

  missingEntrypointContract =
    let
      base = mkExtension {
        name = "agent-container-no-entrypoint-contract";
        packageJson = validPackageJson;
      };
      broken = base // {
        passthru = base.passthru // {
          agentContainer = { };
        };
      };
    in
    builtins.tryEval
      (self.lib.mkAgentContainerBundle {
        inherit pkgs;
        extension = broken;
      }).manifestMetadata.version;

  malformedContract =
    builtins.tryEval
      (self.lib.mkAgentContainerBundle {
        inherit pkgs;
        extension = mkExtension {
          name = "agent-container-malformed-contract";
          packageJson = validPackageJson;
          entrypoint = "../src/index.ts";
        };
      }).manifestMetadata.version;

  absoluteContract =
    builtins.tryEval
      (self.lib.mkAgentContainerBundle {
        inherit pkgs;
        extension = mkExtension {
          name = "agent-container-absolute-contract";
          packageJson = validPackageJson;
          entrypoint = "/src/index.ts";
        };
      }).manifestMetadata.version;

  noDeclaredEntrypoint = self.lib.mkAgentContainerBundle {
    inherit pkgs;
    extension = mkExtension {
      name = "agent-container-no-declared-entrypoint";
      packageJson = validPackageJson // {
        pi.extensions = [ ];
      };
    };
  };

  multipleDeclaredEntrypoints = self.lib.mkAgentContainerBundle {
    inherit pkgs;
    extension = mkExtension {
      name = "agent-container-multiple-declared-entrypoints";
      packageJson = validPackageJson // {
        pi.extensions = [
          "./src/index.ts"
          "./src/other.ts"
        ];
      };
      files = [
        "src/index.ts"
        "src/other.ts"
      ];
    };
  };

  missingEntrypointLeaf = self.lib.mkAgentContainerBundle {
    inherit pkgs;
    extension = mkExtension {
      name = "agent-container-missing-entrypoint-leaf";
      packageJson = validPackageJson;
      files = [ ];
    };
  };

  failedNoDeclaredEntrypoint = pkgs.testers.testBuildFailure noDeclaredEntrypoint.manifestFile;
  failedMultipleDeclaredEntrypoints = pkgs.testers.testBuildFailure multipleDeclaredEntrypoints.manifestFile;
  failedMissingEntrypointLeaf = pkgs.testers.testBuildFailure missingEntrypointLeaf.manifestFile;

  missingStoreResourceBundle = self.lib.mkAgentContainerBundle {
    inherit pkgs;
    extension = fakeExtension;
    modules = [
      {
        pi.coding-agent.extraArgs = [
          "--skill"
          "${intercom}/does-not-exist"
        ];
      }
    ];
  };
  failedMissingStoreResource = pkgs.testers.testBuildFailure missingStoreResourceBundle.runtimeBundle;

  secretEnvironmentOverridden = evalBundle [
    {
      _file = "secret-environment.nix";
      pi.coding-agent.environment.OPENROUTER_API_KEY.file = "/run/keys/openrouter";
    }
    {
      pi.coding-agent.environment = lib.mkForce null;
    }
  ];

  arbitraryEnvironment = evalBundle [
    {
      pi.coding-agent.environment.HARMLESS.value = "not-allowlisted";
    }
  ];

  zeroTimeoutDefinition = evalBundle [
    {
      pi.coding-agent.environment.PI_INTERCOM_ASK_TIMEOUT_MS.value = "0";
    }
    {
      pi.coding-agent.environment = lib.mkForce null;
    }
  ];

  leadingZeroTimeoutDefinition = evalBundle [
    {
      pi.coding-agent.environment.PI_INTERCOM_ASK_TIMEOUT_MS.value = "0300";
    }
    {
      pi.coding-agent.environment = lib.mkForce null;
    }
  ];

  credentialModelFileOverridden = evalBundle [
    {
      _file = "credential-models.nix";
      pi.coding-agent.models = pkgs.writeText "credential-models.json" "{}";
    }
    {
      pi.coding-agent.models = lib.mkForce null;
    }
  ];

  providerApiKeyOverridden = evalBundle [
    {
      _file = "provider-api-key.nix";
      pi.coding-agent.settings.providers.example.apiKey = "not-a-real-key";
    }
    {
      pi.coding-agent.settings = lib.mkForce { };
    }
  ];

  opaqueFalseIfSettingsSecret = evalBundle [
    {
      pi.coding-agent.settings.providers.example = lib.mkIf false {
        apiKey = "not-a-real-key";
      };
    }
  ];

  opaqueFalseIfConfigExtension = fakeExtension // {
    passthru = fakeExtension.passthru // {
      configFiles = fakeExtension.passthru.configFiles // {
        "opaque/config.json".providers.example = lib.mkIf false {
          apiKey = "not-a-real-key";
        };
      };
    };
  };
  opaqueFalseIfConfigSecret = evalExtension opaqueFalseIfConfigExtension;

  providerToken = evalBundle [
    {
      pi.coding-agent.settings.providers.example.token = "not-a-real-token";
    }
  ];

  modelCredentialCommand = evalBundle [
    {
      pi.coding-agent.settings.models.example.credentialCommand = "read-a-secret";
    }
  ];

  modelCredentialPath = evalBundle [
    {
      pi.coding-agent.settings.models.example.credentialPath = "/run/credentials/model";
    }
  ];

  strippedRequiredExtensions = evalBundle [
    {
      pi.coding-agent.extensions = lib.mkForce [ ];
    }
  ];

  mutableExtensionArgument = evalBundle [
    {
      pi.coding-agent.extraArgs = [ "--extension=/tmp/mutable.ts" ];
    }
  ];

  traversingStoreArgument = evalBundle [
    {
      pi.coding-agent.extraArgs = [
        "--extension=/nix/store/00000000000000000000000000000000-fake/../../../../tmp/mutable.ts"
      ];
    }
  ];

  contextlessStoreArgument = evalBundle [
    {
      pi.coding-agent.extraArgs = [
        "--extension=/nix/store/00000000000000000000000000000000-fake/src/index.ts"
      ];
    }
  ];

  mutableShortExtensionArgument = evalBundle [
    {
      pi.coding-agent.extraArgs = [
        "-e"
        "/tmp/mutable.ts"
      ];
    }
  ];

  mutableFileArgument = evalBundle [
    {
      pi.coding-agent.extraArgs = [ "@/etc/passwd" ];
    }
  ];

  adapterOwnedArgumentVectors = [
    [ "--continue" ]
    [ "-c" ]
    [ "--resume" ]
    [ "-r" ]
    [
      "--session"
      "/tmp/session.jsonl"
    ]
    [
      "--session-id"
      "session-id"
    ]
    [
      "--fork"
      "/tmp/session.jsonl"
    ]
    [
      "--session-dir"
      "/tmp/sessions"
    ]
    [ "--no-session" ]
    [
      "--name"
      "session-name"
    ]
    [
      "-n"
      "session-name"
    ]
    [
      "--export"
      "/tmp/export.html"
    ]
    [ "--approve" ]
    [ "-a" ]
    [ "--no-approve" ]
    [ "-na" ]
  ];
  adapterOwnedArguments = map (
    args:
    evalBundle [
      {
        pi.coding-agent.extraArgs = args;
      }
    ]
  ) adapterOwnedArgumentVectors;

  forbiddenArgumentVectors = [
    [ "--print" ]
    [ "-p" ]
    [
      "--print"
      "prompt"
    ]
    [
      "--mode"
      "text"
    ]
    [ "--mode=rpc" ]
    [ "plain prompt" ]
    [ "auth" ]
    [ "config" ]
    [ "install" ]
    [ "update" ]
    [ "@relative.txt" ]
    [ "@" ]
    [
      "--api-key"
      "not-a-real-key"
    ]
    [ "--api-key=not-a-real-key" ]
    [ "--help" ]
    [ "-h" ]
    [ "--version" ]
    [ "-v" ]
    [ "--list-models" ]
    [ "--model=example" ]
    [ "--no-context-files" ]
    [ "-nc" ]
    [ "--no-skills" ]
    [ "-ns" ]
    [ "--no-prompt-templates" ]
    [ "-np" ]
    [ "--no-themes" ]
    [ "--verbose" ]
    [
      "--tui-mode"
      "regular"
    ]
    [
      "--tui-mode"
      "impossible"
    ]
    [
      "--thinking"
      "impossible"
    ]
    [
      "--use-theme"
      "--print"
    ]
    [ "--undeclared-extension-flag" ]
  ];
  forbiddenArguments = map (
    args:
    evalBundle [
      {
        pi.coding-agent.extraArgs = args;
      }
    ]
  ) forbiddenArgumentVectors;

  stableSelections = evalBundle [
    {
      pi.coding-agent.extraArgs = [
        "--provider"
        "openai-codex"
        "--model"
        "example"
        "--thinking"
        "high"
        "--use-theme"
        "dark"
        "--no-builtin-tools"
        "--offline"
      ];
    }
  ];

  disabledRequiredExtensions = evalBundle [
    {
      pi.coding-agent.extraArgs = [ "--no-extensions" ];
    }
  ];

  spoofedRequiredExtensions = evalBundle [
    {
      pi.coding-agent.extensions = lib.mkForce [ ];
      pi.coding-agent.extraArgs = [
        "--skill"
        "${fakeExtension}/src/index.ts"
        "--skill"
        bundle.manifestMetadata.intercom.package
      ];
    }
  ];

  mutableSettingsExtension = evalBundle [
    {
      pi.coding-agent.settings.extensions = [ "/tmp/mutable.ts" ];
    }
  ];

  malformedSettingsExtension = evalBundle [
    {
      pi.coding-agent.settings.extensions = { };
    }
  ];

  settingsShellPath = evalBundle [
    {
      pi.coding-agent.settings.shellPath = "/tmp/mutable-sh";
    }
  ];

  settingsCredentialProxy = evalBundle [
    {
      pi.coding-agent.settings.httpProxy = "http://user:not-a-real-password@proxy.invalid";
    }
  ];

  settingsProxyOverridden = evalBundle [
    {
      pi.coding-agent.settings.httpProxy = "http://proxy.invalid";
    }
    {
      pi.coding-agent.settings = lib.mkForce { };
    }
  ];

  settingsExtensionOverridden = evalBundle [
    {
      pi.coding-agent.settings.extensions = [ "/tmp/mutable.ts" ];
    }
    {
      pi.coding-agent.settings = lib.mkForce { };
    }
  ];

  projectTrustAlways = evalBundle [
    {
      pi.coding-agent.settings.defaultProjectTrust = "always";
    }
  ];

  reservedConfigPath = evalExtension (extensionWithConfig "models.json");
  privateConfigPaths = [
    "auth.json"
    "oauth.json"
    "oauth.json.migrated"
    "trust.json"
    "models-store.json"
    "sessions/seed.jsonl"
    "seed.jsonl"
    "auth.json.lock"
    "models-store.json.lock"
    "settings.json.lock"
    "trust.json.lock"
  ];
  privateConfigPathResults = map (
    relativePath: evalExtension (extensionWithConfig relativePath)
  ) privateConfigPaths;
  traversingConfigPath = evalExtension (extensionWithConfig "../outside.json");

  requestedAlways = self.lib.mkAgentContainerBundle {
    inherit pkgs;
    extension = fakeExtension;
    modules = [
      {
        pi.coding-agent.messaging.inboundTrigger = "always";
      }
    ];
  };

  strongerAlwaysOverride = evalBundle [
    {
      pi.coding-agent.messaging.inboundTrigger = lib.mkOverride (-1) "always";
    }
  ];

  disabledIntercomPackage = intercom // {
    passthru = intercom.passthru // {
      configFiles = lib.recursiveUpdate intercom.passthru.configFiles {
        "intercom/config.json".enabled = false;
      };
    };
  };
  disabledIntercomPassthru = evalBundle [
    {
      pi.coding-agent.messaging.package = lib.mkOverride (-1) disabledIntercomPackage;
    }
  ];

  disabledExtensionsEqualsSpoof = evalBundle [
    {
      pi.coding-agent = {
        extensionPackages = lib.mkOverride (-1) [ ];
        messaging.enable = lib.mkOverride (-1) false;
        extraArgs = [
          "--extension=${fakeExtension}/src/index.ts"
          "--extension=${bundle.manifestMetadata.intercom.package}"
        ];
      };
    }
  ];

  specialArgsModule = evalBundle [
    (
      { specialArgs, ... }:
      {
        pi.coding-agent.settings.defaultProjectTrust = if specialArgs ? pkgs then "never" else "always";
      }
    )
  ];

  completeModuleArgs = evalBundle [
    (args: {
      pi.coding-agent.settings.defaultProjectTrust =
        if args ? specialArgs && args ? _class && args ? _prefix then "never" else "always";
    })
  ];

  modulesPathProvenance =
    builtins.tryEval
      (self.lib.mkAgentContainerBundle {
        inherit pkgs;
        extension = fakeExtension;
        extraSpecialArgs.modulesPath = "/nix/store";
        modules = [
          {
            key = "/nix/store/K";
            config.pi.coding-agent.settings.providers.example.apiKey = "not-a-real-key";
          }
          {
            disabledModules = [ "K" ];
            config.pi.coding-agent.settings = lib.mkForce { };
          }
        ];
      }).manifestMetadata.version;

  anonymousKeyProvenance = evalBundle [
    { key = ":anon-4"; }
    {
      pi.coding-agent.settings.providers.example.apiKey = "not-a-real-key";
    }
    {
      pi.coding-agent.settings = lib.mkForce { };
    }
  ];

  importedAnonymousKeyProvenance = evalBundle [
    { key = ":anon-4:anon-1"; }
    {
      imports = [
        {
          config.pi.coding-agent.settings.providers.example.apiKey = "not-a-real-key";
        }
      ];
    }
    {
      config.pi.coding-agent.settings = lib.mkForce { };
    }
  ];

  duplicateAncestorImportProvenance = evalBundle [
    {
      key = "duplicate-ancestor";
      imports = [
        {
          key = "duplicate-ancestor";
          imports = [
            {
              config.pi.coding-agent.settings.providers.example.apiKey = "not-a-real-key";
            }
          ];
        }
      ];
    }
  ];

  deepImportProvenance = evalBundle [
    (lib.foldr (_: imported: { imports = [ imported ]; }) { } (lib.range 0 128))
  ];

  maximumImportDepthProvenance = evalBundle [
    (lib.foldr (_: imported: { imports = [ imported ]; }) { } (lib.range 0 127))
  ];

  internalConfigProvenance = evalBundle [
    (
      { config, ... }:
      {
        pi.coding-agent.settings = lib.mkIf (config ? _module) {
          providers.example.apiKey = "not-a-real-key";
        };
      }
    )
    {
      pi.coding-agent.settings = lib.mkForce { };
    }
  ];

  manifestMetadataJSON = builtins.toJSON bundle.manifestMetadata;
  policyJSON = builtins.toJSON bundle.policy;
  json = pkgs.formats.json { };
  expectedArgsFile = json.generate "expected-agent-container-args.json" bundle.args;
  expectedEnvironmentFile = json.generate "expected-agent-container-environment.json" bundle.environment;
  expectedPolicyFile = json.generate "expected-agent-container-policy.json" bundle.policy;
in
assert bundle.package == self.packages.${system}.coding-agent-bun;
assert bundle.source == self.packages.${system}.coding-agent-source;
assert bundle.piSource == self.packages.${system}.coding-agent-source;
assert bundle.manifestMetadata.version == 1;
assert
  bundle.manifestMetadata.piVersion == (builtins.fromJSON (builtins.readFile ../VERSION.json)).rev;
assert bundle.manifestMetadata.piSource == "${bundle.piSource}";
assert bundle.manifestMetadata.extensionEntrypoint == "src/index.ts";
assert bundle.manifestMetadata.adapterProtocol == 1;
assert bundle.manifestMetadata.controlProtocol == 1;
assert bundle.manifestMetadata.providerProtocol == 1;
assert bundle.manifestMetadata.intercomProtocol == 1;
assert !(bundle.manifestMetadata ? extensionProtocol);
assert bundle.manifestMetadata.inboundTrigger == "replies";
assert requestedAlways.manifestMetadata.inboundTrigger == "replies";
assert lib.assertMsg (!opaqueFalseIfSettingsSecret.success && !opaqueFalseIfConfigSecret.success)
  "opaque definition escapes: settings=${toString opaqueFalseIfSettingsSecret.success} config=${toString opaqueFalseIfConfigSecret.success}";
assert !strongerAlwaysOverride.success;
assert !disabledIntercomPassthru.success;
assert !disabledExtensionsEqualsSpoof.success;
assert specialArgsModule.success;
assert completeModuleArgs.success;
assert lib.assertMsg (lib.all (result: !result.success) forbiddenArguments)
  "closed invocation grammar escaped: ${
    builtins.toJSON (map (result: result.success) forbiddenArguments)
  }";
assert !modulesPathProvenance.success;
assert !anonymousKeyProvenance.success;
assert !importedAnonymousKeyProvenance.success;
assert !duplicateAncestorImportProvenance.success;
assert !deepImportProvenance.success;
assert maximumImportDepthProvenance.success;
assert !internalConfigProvenance.success;
assert lib.elem "${fakeExtension}/src/index.ts" bundle.args;
assert lib.elem bundle.manifestMetadata.intercom.package bundle.args;
assert lib.elem "${fakeExtension}/src/index.ts" bundle.resources.extensions;
assert lib.any (
  path: lib.hasSuffix "-pi-extension-prompt-fragments.md" (toString path)
) bundle.resources.argumentPaths;
assert lib.all (path: lib.elem path bundle.runtimeInputs) bundle.resources.argumentPaths;
assert bundle.resources.extensionConfigFiles != { };
assert bundle.runtimeInputs != [ ];
assert lib.elem bundle.package bundle.runtimeInputs;
assert lib.elem bundle.configTree bundle.runtimeInputs;
assert
  bundle.environment == {
    PI_INTERCOM_ASK_TIMEOUT_MS = "300000";
  };
assert !missingContract.success;
assert !missingEntrypointContract.success;
assert !malformedContract.success;
assert !absoluteContract.success;
assert !secretEnvironmentOverridden.success;
assert !arbitraryEnvironment.success;
assert zeroTimeoutDefinition.success;
assert !leadingZeroTimeoutDefinition.success;
assert !credentialModelFileOverridden.success;
assert !providerApiKeyOverridden.success;
assert !providerToken.success;
assert !modelCredentialCommand.success;
assert !modelCredentialPath.success;
assert !strippedRequiredExtensions.success;
assert !mutableExtensionArgument.success;
assert !traversingStoreArgument.success;
assert !contextlessStoreArgument.success;
assert !mutableShortExtensionArgument.success;
assert lib.assertMsg (lib.all (result: !result.success) adapterOwnedArguments)
  "adapter-owned arguments escaped: ${
    builtins.toJSON (map (result: result.success) adapterOwnedArguments)
  }";
assert !mutableFileArgument.success;
assert stableSelections.success;
assert !disabledRequiredExtensions.success;
assert !spoofedRequiredExtensions.success;
assert !mutableSettingsExtension.success;
assert !malformedSettingsExtension.success;
assert !settingsShellPath.success;
assert !settingsCredentialProxy.success;
assert !settingsProxyOverridden.success;
assert !settingsExtensionOverridden.success;
assert !projectTrustAlways.success;
assert !reservedConfigPath.success;
assert lib.assertMsg (lib.all (result: !result.success) privateConfigPathResults)
  "private config paths escaped: ${
    builtins.toJSON (map (result: result.success) privateConfigPathResults)
  }";
assert !traversingConfigPath.success;
assert !secretExtensionSettingsOverridden.success;
assert !(lib.hasInfix "API_KEY" manifestMetadataJSON);
assert !(lib.hasInfix "apiKey" manifestMetadataJSON);
assert !(lib.hasInfix "API_KEY" policyJSON);
assert !(lib.hasInfix "apiKey" policyJSON);
pkgs.runCommand "agent-container-bundle-contract" { nativeBuildInputs = [ pkgs.jq ]; } ''
  set -euo pipefail

  test -x ${bundle.package}/bin/pi
  test -x ${bundle.runtimeBundle}/bin/pi
  test -e ${bundle.runtimeBundle}
  test -e ${bundle.source}/packages/coding-agent/package.json
  test -f ${bundle.configTree}/args.json
  test -f ${bundle.configTree}/environment.json
  test -f ${bundle.configTree}/settings.json
  test -f ${bundle.configTree}/models.json
  test -f ${bundle.configTree}/policy.json
  test -f ${bundle.configTree}/agent-container-bundle.json
  test -f ${bundle.configTree}/intercom/config.json
  test -f ${bundle.configTree}/agent-container/config.json
  test -f ${bundle.configTree}/resource-inventory.json
  test ! -e ${bundle.configTree}/auth.json
  test ! -e ${bundle.configTree}/oauth.json
  test ! -e ${bundle.configTree}/oauth.json.migrated
  test ! -e ${bundle.configTree}/trust.json
  test ! -e ${bundle.configTree}/models-store.json
  test ! -e ${bundle.configTree}/sessions
  test -z "$(find ${bundle.configTree} -maxdepth 1 -type f -name '*.jsonl' -print -quit)"
  test -z "$(find ${bundle.configTree} -maxdepth 1 -type f \
    \( -name 'auth.json.lock' -o -name 'models-store.json.lock' \
       -o -name 'settings.json.lock' -o -name 'trust.json.lock' \) \
    -print -quit)"
  test -e ${bundle.piSource}/packages/coding-agent/package.json
  cmp ${expectedArgsFile} ${bundle.configTree}/args.json
  cmp ${expectedEnvironmentFile} ${bundle.configTree}/environment.json
  cmp ${expectedPolicyFile} ${bundle.configTree}/policy.json
  cmp ${bundle.configTree}/args.json ${bundle.runtimeBundle}/args.json
  cmp ${bundle.configTree}/environment.json ${bundle.runtimeBundle}/environment.json
  cmp ${bundle.configTree}/policy.json ${bundle.runtimeBundle}/policy.json
  cmp ${bundle.manifestFile} ${bundle.configTree}/agent-container-bundle.json
  ${lib.concatStringsSep "\n" (
    lib.imap0 (index: input: ''
      test "$(readlink ${bundle.runtimeBundle}/runtime-inputs/${toString index})" = ${lib.escapeShellArg (toString input)}
    '') bundle.runtimeInputs
  )}

  jq -e --arg entrypoint '${fakeExtension}/src/index.ts' 'index($entrypoint) != null' \
    ${bundle.runtimeBundle}/args.json >/dev/null
  jq -e '. == {"PI_INTERCOM_ASK_TIMEOUT_MS":"300000"}' \
    ${bundle.runtimeBundle}/environment.json >/dev/null

  jq -e '.version == 1' ${bundle.manifestFile} >/dev/null
  jq -e '.adapterProtocol == 1 and .controlProtocol == 1 and .providerProtocol == 1 and .intercomProtocol == 1' \
    ${bundle.manifestFile} >/dev/null
  jq -e 'has("extensionProtocol") | not' ${bundle.manifestFile} >/dev/null
  jq -e '.inboundTrigger == "replies"' ${bundle.manifestFile} >/dev/null
  jq -e '.intercom.packageVersion != ""' ${bundle.manifestFile} >/dev/null
  jq -e '.intercom.paths | keys == ["broker", "brokerEntrypoint", "client", "entrypoint", "framing", "packageJson", "paths", "protocol", "types"]' \
    ${bundle.manifestFile} >/dev/null
  jq -e '.intercom.sha256 | keys == ["broker", "brokerEntrypoint", "client", "entrypoint", "framing", "packageJson", "paths", "protocol", "types"]' \
    ${bundle.manifestFile} >/dev/null
  jq -e '[.intercom.paths[] | test("^[^/]([^/]*)(/[^/]+)*$")] | all' \
    ${bundle.manifestFile} >/dev/null
  jq -e '[.intercom.sha256[] | test("^[0-9a-f]{64}$")] | all' \
    ${bundle.manifestFile} >/dev/null
  jq -e '.extension.paths | keys == ["entrypoint", "packageJson"]' \
    ${bundle.manifestFile} >/dev/null
  jq -e '.extension.sha256 | keys == ["entrypoint", "packageJson"]' \
    ${bundle.manifestFile} >/dev/null
  jq -e '[.extension.paths[] | startswith("/nix/store/")] | all' \
    ${bundle.manifestFile} >/dev/null
  jq -e '[.extension.sha256[] | test("^[0-9a-f]{64}$")] | all' \
    ${bundle.manifestFile} >/dev/null
  jq -e '[.policy.sourceAuthorities[] | (.path | length > 0) and (.sha256 | test("^[0-9a-f]{64}$"))] | all' \
    ${bundle.manifestFile} >/dev/null
  jq -e '.policy.sourceAuthorities | keys == ["api", "auth", "catalog", "provider"]' \
    ${bundle.manifestFile} >/dev/null

  jq -e '.providers.standardcompute == {
    "name":"Standard Compute",
    "baseUrl":"https://api.stdcmpt.com/v1",
    "api":"openai-responses",
    "models":[{
      "id":"standardcompute",
      "name":"Standard Compute",
      "reasoning":false,
      "input":["text","image"],
      "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},
      "contextWindow":200000,
      "maxTokens":8192
    }]
  }' ${bundle.configTree}/models.json >/dev/null
  jq -e '.defaultProjectTrust == "never"' ${bundle.configTree}/settings.json >/dev/null
  jq -e '.inboundTrigger == "replies"' ${bundle.configTree}/intercom/config.json >/dev/null
  jq -e '.extensions | index("${fakeExtension}/src/index.ts") != null' \
    ${bundle.configTree}/resource-inventory.json >/dev/null

  grep -F 'agent-container bundle: package.json must declare exactly one Pi extension' \
    ${failedNoDeclaredEntrypoint}/testBuildFailure.log >/dev/null
  grep -F 'agent-container bundle: package.json must declare exactly one Pi extension' \
    ${failedMultipleDeclaredEntrypoints}/testBuildFailure.log >/dev/null
  grep -F 'agent-container bundle: declared Pi extension leaf does not exist' \
    ${failedMissingEntrypointLeaf}/testBuildFailure.log >/dev/null
  grep -F 'agent-container bundle: runtime input does not exist' \
    ${failedMissingStoreResource}/testBuildFailure.log >/dev/null

  touch "$out"
''
