{
  pkgs,
  regenerateModels,
  sync,
  updateExtensions,
}:

pkgs.writeShellApplication {
  name = "pi-update";
  runtimeInputs = [
    regenerateModels
    sync
    updateExtensions
  ];
  text = # bash
    ''
      set -euo pipefail

      pi-sync

      pi-regenerate-models
      pi-update-extensions
    '';
}
