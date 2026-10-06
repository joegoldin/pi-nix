# @narumitw/pi-usage from a pi-extensions commit rather than npm.
#
# Its ChatGPT companion-mode support (narumiruna/pi-extensions@f5f197f) is
# merged but not yet published; npm still has 0.62.0. This builds the package
# straight from the monorepo and loads its TypeScript source: the npm tarball's
# dist/index.ts is only an esbuild bundle of the same src/, and pi loads
# TypeScript itself. Its one dependency, pi-tui-kit, is imported lazily and
# comes from the vendored lockfile like any pin's.
#
# Move it back to extensions.json once a release containing f5f197f is on npm;
# until then `nix run .#update-extensions` must not see it, or it would pin the
# older release over this.
{
  fetchFromGitHub,
  mkPiExtension,
}:
let
  rev = "5c2c83c05ea6c8a93a84e987f60927761e6814ac";
  monorepo = fetchFromGitHub {
    owner = "narumiruna";
    repo = "pi-extensions";
    inherit rev;
    hash = "sha256-vQF+HnHF/lC0i5bhs9HlR1VafHHIpEdNLs0epTe9EiE=";
  };
in
mkPiExtension {
  pname = "@narumitw/pi-usage";
  version = "0.62.0-unstable-2026-10-06";
  src = "${monorepo}/packages/pi-usage";
  bunLock = ./narumitw-pi-usage/bun.lock;
  bunNix = ./narumitw-pi-usage/bun.nix;
  entrypoints = [ "src/index.ts" ];
  meta.homepage = "https://github.com/narumiruna/pi-extensions/tree/${rev}/packages/pi-usage";
}
