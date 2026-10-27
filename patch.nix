{ pkgs }:

# Temporary downstream workarounds, applied in the extracted upstream source
# before generating lockfiles. Remove each block once upstream makes it redundant.
pkgs.writeShellApplication {
  name = "pi-patch";
  runtimeInputs = [ pkgs.patch ];
  text = # bash
    ''
      patch --batch --forward -p1 < ${./coding-agent/installer-chord.patch}
      patch --batch --forward -p1 < ${./coding-agent/dependency-updates.patch}
    '';
}
