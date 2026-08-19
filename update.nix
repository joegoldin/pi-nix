{
  pkgs,
  regenerateModels,
  syncUpstream,
  updateExtensions,
}:

pkgs.writeShellApplication {
  name = "pi-update";
  runtimeInputs = [
    regenerateModels
    syncUpstream
    updateExtensions
  ];
  text = # bash
    ''
      set -euo pipefail

      pi-sync-upstream
      pi-regenerate-models
      pi-update-extensions
    '';
}
