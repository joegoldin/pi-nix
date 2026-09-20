{
  pkgs,
  regenerateModels,
  syncUpstream,
}:

pkgs.writeShellApplication {
  name = "pi-update";
  runtimeInputs = [
    regenerateModels
    syncUpstream
  ];
  text = # bash
    ''
      set -euo pipefail

      pi-sync-upstream

      pi-regenerate-models
    '';
}
