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
  web-access = import ./web-access-test.nix args;
  mcp-adapter = import ./mcp-adapter-test.nix args;
  queued-messages = import ./queued-messages-test.nix args;
  editor-input = import ./editor-input-test.nix args;
  program-status = import ./program-status-test.nix args;
  sidebar = import ./sidebar-test.nix args;
  extension-dialogs = import ./extension-dialogs-test.nix args;
  subagent-host-peers = import ./subagent-host-peers-test.nix args;
  subagent-expanded-output = import ./subagent-expanded-output-test.nix args;
  fast-mode = import ./fast-mode-test.nix args;
  user-message-timestamps = import ./user-message-timestamps-test.nix args;
  pi-lens-grammars = import ./pi-lens-grammars-test.nix args;
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
