# @gotgenes/pi-permission-system: the rule engine every other gate in this
# module composes with, and the owner of the authorizer chain auto mode
# registers on.
#
# Built from its own file rather than the generic loop for one reason: the
# bounded-delegation checkpoint's excluded-surface set is a module-level
# literal with no configuration seam, and this repo's jail needs a different
# one. One patch, --replace-fail, so an upstream change breaks the build rather
# than silently reverting it. See
# gotgenes-pi-permission-system-patches.nix for the argument.
{
  mkPiExtension,
  pin,
  configurableDelegationEnvelope,
}:
mkPiExtension {
  pname = "@gotgenes/pi-permission-system";
  inherit (pin)
    version
    url
    hash
    bundled
    entrypoints
    skills
    prompts
    ;

  bunLock = ./gotgenes-pi-permission-system/bun.lock;
  bunNix = ./gotgenes-pi-permission-system/bun.nix;

  patchPhaseExtra = configurableDelegationEnvelope;
}
