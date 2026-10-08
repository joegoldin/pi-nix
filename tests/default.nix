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
  permissions-upstream = import ./permissions-upstream-test.nix args;
  intercom-hardening = import ./intercom-hardening-test.nix args;
  intercom-smoke = import ./intercom-smoke-test.nix args;
  messaging-option = import ./messaging-option-test.nix args;
  prompt-fragment-inventory = import ./prompt-lint.nix args;
}
// import ./extension-tests.nix args
