# Asserts the mkPiExtension passthru contract. Five of the six fields are
# phase 2's (docs/plans/2026-08-18-pi-nix-fork.md Task 3); configFiles is added
# by the messaging plan because pi-intercom's inboundTrigger, the security
# default the whole phase turns on, lives in an extension-owned config file
# with no environment override.
#
# This exists so a package that drops a field, or a refactor that turns
# piEntrypoint back into a scalar, fails the build rather than failing at
# runtime inside somebody's pi session.
{
  pkgs,
  self,
  ...
}:
let
  inherit (pkgs) lib;
  inherit (pkgs.stdenv.hostPlatform) system;

  extensions = lib.filterAttrs (n: _: lib.hasPrefix "ext-" n) self.packages.${system};

  listOfStr = v: lib.isList v && lib.all lib.isString v;

  fieldChecks = {
    piEntrypoint = listOfStr;
    piSkills = listOfStr;
    piPrompts = listOfStr;
    settings = lib.isAttrs;
    configFiles = v: lib.isAttrs v && lib.all lib.isAttrs (lib.attrValues v);
    promptFragment = v: v == null || lib.isString v;
  };

  checkOne =
    name: drv:
    let
      present = lib.filter (f: drv.passthru ? ${f}) (lib.attrNames fieldChecks);
      missing = lib.filter (f: !(drv.passthru ? ${f})) (lib.attrNames fieldChecks);
      wrong = lib.filter (f: !(fieldChecks.${f} drv.passthru.${f})) present;
    in
    if missing != [ ] then
      throw "extension contract: ${name} is missing passthru.${lib.concatStringsSep ", passthru." missing}"
    else if wrong != [ ] then
      throw "extension contract: ${name} has the wrong type for passthru.${lib.concatStringsSep ", passthru." wrong} (piEntrypoint/piSkills/piPrompts are LISTS of strings; configFiles is an attrset of attrsets)"
    else
      ''
        ${lib.concatMapStringsSep "\n" (e: ''
          test -e ${lib.escapeShellArg e} || { echo "${name}: entrypoint ${e} does not exist"; exit 1; }
        '') drv.passthru.piEntrypoint}
        ${lib.concatMapStringsSep "\n" (s: ''
          test -d ${lib.escapeShellArg s} || { echo "${name}: skill ${s} is not a directory"; exit 1; }
        '') drv.passthru.piSkills}
        ${lib.concatMapStringsSep "\n" (rel: ''
          case ${lib.escapeShellArg rel} in
            /*|*..*) echo "${name}: configFiles key ${rel} must be a relative path with no .."; exit 1 ;;
          esac
        '') (lib.attrNames drv.passthru.configFiles)}
        echo "${name}: contract ok (${toString (lib.length drv.passthru.piEntrypoint)} entrypoint(s), ${toString (lib.length drv.passthru.piSkills)} skill(s), ${toString (lib.length (lib.attrNames drv.passthru.configFiles))} config file(s))"
      '';
in
# A green check over an empty extension set asserts nothing, so the empty set is
# itself a failure.
if extensions == { } then
  throw "extension contract: no ext-* packages found; the check would be vacuously green"
else
  pkgs.runCommand "pi-nix-extension-contract" { } ''
    ${lib.concatStringsSep "\n" (lib.mapAttrsToList checkOne extensions)}
    touch $out
  ''
