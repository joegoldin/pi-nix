# Patches applied to @gotgenes/pi-permission-system's shipped TypeScript.
# --replace-fail, so an upstream edit that moves the target breaks the build
# instead of silently reverting a security default.
{ lib }:
let
  lines = lib.concatStringsSep "\n";

  # src/authority/delegation-envelope.ts as published in 26.3.0. The set is a
  # module-level literal with no seam to configure it, which is the whole
  # reason this file exists.
  original = lines [
    "export const DELEGATION_EXCLUDED_SURFACES: ReadonlySet<string> = new Set(["
    "  \"external_directory\","
    "  \"path\","
    "]);"
  ];

  configurable = lines [
    "const DEFAULT_DELEGATION_EXCLUDED_SURFACES = [\"external_directory\", \"path\"];"
    ""
    "/**"
    " * Patched by pi-nix. Upstream hardcodes the set; this reads"
    " * PI_PERMISSION_DELEGATION_EXCLUDED_SURFACES, a comma-separated surface"
    " * list, and falls back to upstream's literal when it is unset or parses to"
    " * nothing. The fallback is the fail-safe direction: a typo cannot silently"
    " * disable the checkpoint, only fail to narrow it."
    " */"
    "export const DELEGATION_EXCLUDED_SURFACES: ReadonlySet<string> = new Set("
    "  (() => {"
    "    const raw = process.env.PI_PERMISSION_DELEGATION_EXCLUDED_SURFACES;"
    "    if (raw === undefined) return DEFAULT_DELEGATION_EXCLUDED_SURFACES;"
    "    const parsed = raw"
    "      .split(\",\")"
    "      .map((s) => s.trim())"
    "      .filter((s) => s.length > 0);"
    "    return parsed.length > 0 ? parsed : DEFAULT_DELEGATION_EXCLUDED_SURFACES;"
    "  })(),"
    ");"
  ];
in
{
  # ADR 0007 §5's bounded-delegation checkpoint caps a registered link's `allow`
  # to `defer` on an excluded surface, so a judge can never exceed the
  # operator's policy. Upstream excludes `path` and `external_directory`, and
  # says why: a finer secret-shaped-`path` exclusion is deferred to a later
  # slice, so "the conservative whole-surface exclusion ships".
  #
  # That default is right for a host where "outside the working directory" means
  # the whole filesystem. It is the wrong shape for a bubblewrap jail, where the
  # only paths that exist outside the working directory are the ones the wrapper
  # bound by name, and where the interesting ones -- /etc, /proc, /tmp -- are
  # session-local mounts that cannot outlive the process. There, every
  # `external_directory` ask is a prompt the operator must answer by hand about
  # a directory they already decided to bind, and the classifier that was
  # installed to answer exactly this class of question is forbidden from
  # touching it.
  #
  # So the set becomes configurable rather than different: unset, this build
  # behaves exactly as upstream does. A consumer opts in per host, and `path`
  # stays excluded either way -- that is the surface that guards secrets, and a
  # `path` deny cannot be overridden by any per-tool allow.
  configurableDelegationEnvelope = ''
    substituteInPlace src/authority/delegation-envelope.ts --replace-fail ${lib.escapeShellArg original} ${lib.escapeShellArg configurable}
  '';
}
