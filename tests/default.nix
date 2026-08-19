# Every check in this repo is assembled here so flake.nix has exactly one
# insertion point. Each test file takes the same argument set; unused
# arguments are absorbed by the `...` in its header.
{
  pkgs,
  self,
  jail-nix,
}:
let
  args = { inherit pkgs self jail-nix; };
in
{
  smoke = import ./smoke-test.nix args;
  builders = import ./lib-test.nix args;
  extensions = import ./extensions-test.nix args;
  update-app = import ./update-app-test.nix args;
  options = import ./options-test.nix args;
  additive = import ./additive-test.nix args;
  extension-contract = import ./extension-contract-test.nix args;
  pi-intercom-hardening = import ./pi-intercom-hardening-test.nix args;
  pi-intercom-broker-tests = import ./pi-intercom-broker-tests.nix args;
  pi-intercom-smoke = import ./pi-intercom-smoke-test.nix args;
  messaging-option = import ./messaging-option-test.nix args;
}
// import ./extension-tests.nix args
