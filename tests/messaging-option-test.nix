# Eval-level assertions on the messaging option. Cheap, and it catches the
# mistakes that would actually hurt: a default that lets an unauthenticated
# local peer drive the agent, a config file written to a path pi-custom never
# reads, a broker command that resolves through PATH, a second copy of the
# intercom tool, and Claude Code peering switched on inside a jail that cannot
# reach Claude's registry.
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
        ext-pi-permissions
        ext-pi-notify
        ext-pi-custom
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
  # Intercom is part of pi-custom, so every case that turns messaging on turns
  # pi-custom on too, and `customOnly` is the baseline it must not add to.
  customOnly = evalModule { custom.enable = true; };
  on = evalModule {
    custom.enable = true;
    messaging.enable = true;
  };
  loud = evalModule {
    custom.enable = true;
    messaging.enable = true;
    messaging.inboundTrigger = "always";
    messaging.claude.fromMode = "bypass";
  };
  jailed = evalModule {
    custom.enable = true;
    messaging.enable = true;
    jail.enable = true;
  };

  # Forced deeply because the refusal sits on the values, not the attribute
  # names. tryEval cannot see a throw's text, so this proves the eval fails,
  # not which message it fails with.
  withoutCustom =
    let
      cfg = evalModule { messaging.enable = true; };
    in
    builtins.tryEval (builtins.deepSeq cfg.finalConfigFiles cfg.finalConfigFiles);

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
      name = "enabled loads nothing beyond pi-custom, so the intercom tool registers once";
      ok =
        flagValues on.finalArgs "--extension" == flagValues customOnly.finalArgs "--extension"
        && flagValues on.finalArgs "--extension" != [ ];
    }
    {
      name = "enabling messaging without pi-custom fails evaluation";
      ok = !withoutCustom.success;
    }
    {
      name = "the config lands at intercom/config.json, not settings.json";
      ok = lib.attrNames on.finalConfigFiles == [ "intercom/config.json" ] && on.settings == { };
    }
    {
      name = "the config switches intercom on";
      ok = (intercomConfig on).enabled == true;
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
      name = "Claude Code peering defaults to on, prompting, outside the jail";
      ok =
        (intercomConfig on).claude == {
          enabled = true;
          fromMode = "prompting";
        };
    }
    {
      name = "fromMode is overridable to bypass";
      ok = (intercomConfig loud).claude.fromMode == "bypass";
    }
    {
      name = "Claude Code peering defaults to off under the jail, which cannot reach its registry";
      ok = (intercomConfig jailed).claude.enabled == false;
    }
    {
      name = "no skill is passed";
      ok = flagValues on.finalArgs "--skill" == [ ];
    }
    {
      name = "runtimeInputs are surfaced for the jail";
      ok = on.messagingRuntimeInputs != [ ];
    }
    {
      name = "the untrusted-peer prompt fragment reaches the appended prompt";
      ok =
        lib.any (lib.hasInfix (builtins.readFile ../prompt/untrusted-peer-input.md)) appendedPrompts
        && flagValues customOnly.finalArgs "--append-system-prompt" == [ ];
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
