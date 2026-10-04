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

      # The shipped dependency tree has no build-only advisory exceptions.
      osv-scanner scan source --config osv-scanner.toml --lockfile coding-agent/install-lock/package-lock.json

      osv-scanner scan source --config osv-scanner-workspace.toml --lockfile package-lock.json
      osv-scanner scan source --config osv-scanner-workspace.toml --lockfile bun.lock

      gitleaks dir --redact --config .gitleaks.toml .
    '';
}
