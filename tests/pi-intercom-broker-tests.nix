# Runs pi-intercom's own shipped tests against the exact tree we install. The
# tarball includes broker/*.test.ts, so this costs one derivation and catches
# wire-protocol drift the moment a pin bump lands, including drift that would
# move the Task 3 patch target.
{
  pkgs,
  self,
  ...
}:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  ext-pi-intercom = self.packages.${system}.ext-pi-intercom;
in
pkgs.runCommand "pi-nix-pi-intercom-broker-tests"
  {
    nativeBuildInputs = [ pkgs.bun ];
  }
  ''
    cp -R ${ext-pi-intercom}/. work
    chmod -R u+w work
    cd work

    export HOME=$TMPDIR/home
    export PI_CODING_AGENT_DIR=$TMPDIR/agent
    mkdir -p "$HOME" "$PI_CODING_AGENT_DIR"

    # Test set fixed by Task 4 Step 1: six of the seven shipped broker test
    # files. broker/extension.test.ts is excluded because its "extension bus"
    # case fails identically under `tsx --test`, so it is an upstream or
    # environment problem rather than a bun regression. Re-check it at each pin
    # bump; if it starts passing, add it back.
    bun test \
      broker/framing.test.ts \
      broker/paths.test.ts \
      broker/runtime-claim.test.ts \
      broker/client.test.ts \
      broker/client-liveness.test.ts

    # spawn.test.ts runs separately behind a name filter. Two of its eighteen
    # cases drive upstream's DEFAULT launch path, which resolves the literal
    # string "node" through PATH, so they need a Node interpreter the sandbox
    # does not have and this fork never uses. Excluding them by name keeps the
    # sixteen that matter, including the one asserting the custom-brokerCommand
    # branch the module actually takes. Adding nodejs here instead would put a
    # Node on the PATH of a package whose whole point is not needing one.
    bun test broker/spawn.test.ts \
      -t '^(getTsxCliPath|getWindows|getBrokerLaunchSpec|getBrokerSpawnOptions)'

    touch $out
  ''
