{ pkgs }:

pkgs.writeShellApplication {
  name = "pi-scan";
  runtimeInputs = with pkgs; [
    gitleaks
    osv-scanner
    zizmor
  ];
  text = # bash
    ''
      set -euo pipefail

      zizmor .github/workflows

      osv-scanner scan source --lockfile package-lock.json
      osv-scanner scan source --lockfile bun.lock

      gitleaks dir --redact --config .gitleaks.toml .
    '';
}
