# @gotgenes/pi-permission-system: the rule engine every other gate in this
# module composes with, and the owner of the authorizer chain auto mode
# registers on.
#
# Built from its own file rather than the generic loop, for two patches. The
# bounded-delegation checkpoint's excluded-surface set is a module-level
# literal with no configuration seam, and this repo's jail needs a different
# one: --replace-fail, so an upstream change breaks the build rather than
# silently reverting it (see gotgenes-pi-permission-system-patches.nix). And
# pi-permission-system-interrupt.patch gives a chain link an `interrupted`
# verdict, so a call the user stopped the turn on to give guidance (Esc with
# messages queued, which auto mode reports) is logged, broadcast and rendered
# as an interruption rather than as a denial.
{
  patch,
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

  patchPhaseExtra = ''
    ${configurableDelegationEnvelope}
    ${patch}/bin/patch -p1 < ${./pi-permission-system-interrupt.patch}
  '';
}
