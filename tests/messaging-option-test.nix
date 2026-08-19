# Eval-level assertions on the messaging option. Cheap, and it catches the three
# mistakes that would actually hurt: a default that lets an unauthenticated
# local peer drive the agent, a config file written to a path the extension
# never reads, and a broker command that resolves through PATH.
{
  pkgs,
  self,
  ...
}:
let
  inherit (pkgs) lib;
  inherit (pkgs.stdenv.hostPlatform) system;

  selfStub = {
    packages.${system} = {
      coding-agent = pkgs.hello;
      coding-agent-bun = pkgs.cowsay;
      inherit (self.packages.${system})
        ext-pi-auto-mode
        ext-pi-notify
        ext-pi-intercom
        ;
    };
    inputs.agent-statusline = self.inputs.agent-statusline;
  };

  evalModule =
    settings:
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
        { pi.coding-agent = settings; }
      ];
    }).config.pi.coding-agent;

  flagValues =
    args: flag:
    let
      indexed = lib.imap0 (i: a: { inherit i a; }) args;
    in
    map (e: builtins.elemAt args (e.i + 1)) (lib.filter (e: e.a == flag) indexed);

  off = evalModule { };
  on = evalModule { messaging.enable = true; };
  loud = evalModule {
    messaging.enable = true;
    messaging.inboundTrigger = "always";
  };

  intercomConfig = cfg: cfg.finalConfigFiles."intercom/config.json";

  # The fork appends extension prompt fragments through --append-system-prompt
  # on a generated file rather than through upstream's `rules`, so this is where
  # the fragment has to show up.
  appendedPrompts = map (p: builtins.readFile p) (flagValues on.finalArgs "--append-system-prompt");

  assertions = [
    {
      name = "default is disabled";
      ok = off.messaging.enable == false;
    }
    {
      name = "disabled adds no extension";
      ok = flagValues off.finalArgs "--extension" == [ ];
    }
    {
      name = "disabled writes no config files";
      ok = off.finalConfigFiles == { };
    }
    {
      name = "enabled passes exactly one --extension";
      ok = lib.count (a: a == "--extension") on.finalArgs == 1;
    }
    {
      name = "the entrypoint is the package root, so pi reads the pi manifest";
      ok = flagValues on.finalArgs "--extension" == [ "${on.messaging.package}" ];
    }
    {
      name = "the config lands at intercom/config.json, not settings.json";
      ok = lib.attrNames on.finalConfigFiles == [ "intercom/config.json" ] && on.settings == { };
    }
    {
      name = "inboundTrigger defaults to replies";
      ok = (intercomConfig on).inboundTrigger == "replies";
    }
    {
      name = "inboundTrigger is overridable to always";
      ok = (intercomConfig loud).inboundTrigger == "always";
    }
    {
      name = "brokerCommand is a store path so nothing resolves through PATH";
      ok = lib.hasPrefix builtins.storeDir (intercomConfig on).brokerCommand;
    }
    {
      name = "brokerArgs is empty, so the tsx default path is never taken";
      ok = (intercomConfig on).brokerArgs == [ ];
    }
    {
      name = "stableId is never written, or every session would share one ID";
      ok = !((intercomConfig on) ? stableId);
    }
    {
      name = "the bundled skill is not installed by default";
      ok = flagValues on.finalArgs "--skill" == [ ];
    }
    {
      name = "runtimeInputs are surfaced for the jail";
      ok = on.messagingRuntimeInputs != [ ];
    }
    {
      name = "the untrusted-peer prompt fragment reaches the appended prompt";
      ok =
        lib.any (t: t == on.messaging.package.passthru.promptFragment) appendedPrompts
        && lib.any (t: lib.hasInfix "peer" (lib.toLower t)) appendedPrompts;
    }
  ];

  failed = lib.filter (a: !a.ok) assertions;
in
if failed != [ ] then
  throw "messaging option: ${lib.concatMapStringsSep "; " (a: a.name) failed}"
else
  pkgs.runCommand "pi-nix-messaging-option" { } ''
    echo "messaging option: ${toString (lib.length assertions)} assertions ok"
    touch $out
  ''
