# pi-cache-optimizer: prompt-cache accounting and prompt reordering for
# OpenAI-compatible providers.
#
# Built from its own file rather than the generic loop for one reason: it draws
# an unconditional status slot, and a host with its own status line wants the
# numbers once. One patch, --replace-fail. See pi-cache-optimizer-patches.nix.
{
  mkPiExtension,
  pin,
  suppressibleStatusSlot,
}:
mkPiExtension {
  pname = "pi-cache-optimizer";
  inherit (pin)
    version
    url
    hash
    bundled
    entrypoints
    skills
    prompts
    ;

  patchPhaseExtra = suppressibleStatusSlot;
}
