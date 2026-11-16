# Alerts belong to the terminal. Keeping a second notifier reintroduces
# duplicate delivery and bypasses the terminal's focus and click policy.
{ pkgs, self, ... }:
assert !(self.packages.${pkgs.stdenv.hostPlatform.system} ? ext-pi-notify);
pkgs.runCommand "pi-terminal-owned-notifications-tests" { } ''
  test ! -e ${../packages/extensions}/pi-notify
  ! grep -Eq 'PI_NOTIFY_CONFIG|notificationEntrypoints|combinators.notifications|pkgs.libnotify|pkgs.glib.bin' ${../coding-agent/extra-options.nix}
  test -s ${../coding-agent/program-status.patch}
  touch $out
''
