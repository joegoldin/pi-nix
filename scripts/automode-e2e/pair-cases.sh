#!/usr/bin/env bash
# Everything the pair has to show, with both gates loaded against the real pi
# binary, the real fork, and the real permission-system tarball.
#
# all-cases.sh answers "does auto mode work". This answers the question that
# replaced it: does auto mode work *beside* @gotgenes/pi-permission-system, with
# the permission system's deterministic engine still resolving what it can and
# the classifier reached as a chain link rather than a dialog.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ALLOW='{"decision":"allow","tier":"allow","reason":"e2e says allow"}'
BLOCK='{"decision":"block","tier":"soft_deny","reason":"e2e says block"}'
CONTRA='{"decision":"allow","tier":"hard_deny","reason":"e2e contradiction"}'
PROSE='Sure, that looks fine to me!'

automode_settings() { # $1 = extra top-level keys beside autoMode
  cat <<JSON
{"autoMode":{"enabled":true,"classifierModel":"fake/classifier",
"log":{"enabled":true,"classifierIo":true},
"environment":["This is an end-to-end test sandbox."],
"allow":["Reading files inside the working directory is fine."],
"soft_deny":["Deleting files the user did not name."],
"hard_deny":["Never read private SSH keys or other credentials."]}$1}
JSON
}

# The chain entry is the half that arms the link. CHAIN_OFF is the same file
# without it, and it is a case rather than a footnote: an inert registration
# reads exactly like a working one from every other vantage point.
perm_config() { # $1 = bash policy map, $2 = chain fragment
  printf '{"permissionReviewLog":true,"doublePressToConfirm":false%s,"permission":{"*":"ask","bash":%s}}' "$2" "$1"
}
CHAIN_ON=',"authorizerChain":["pi-automode"]'
CHAIN_OFF=''

ASKS='{"*":"ask","git status*":"allow"}'
DENIES='{"*":"ask","rm *":"deny"}'
ALLOWS='{"*":"allow"}'

run() { # name, tool, input, classifier, automode settings, permission config
  echo
  echo "############ $1"
  bash ./run-pair-case.sh "$1" "$2" "$3" "$4" "$5" "$6"
}

# 1. The complaint that started this: a command the operator's own rules allow,
#    resolved with no model call and no prompt.
run pair-deterministic-allow bash '{"command":"git status --short --branch"}' "$ALLOW" \
  "$(automode_settings '')" "$(perm_config "$ASKS" "$CHAIN_ON")"

# 2. The other half of "still resolves what it can": a rule deny, before the
#    chain and before any classifier call.
run pair-deterministic-deny bash '{"command":"rm -rf CANARY"}' "$ALLOW" \
  "$(automode_settings '')" "$(perm_config "$DENIES" "$CHAIN_ON")"

# 3. An ask the engine cannot settle reaches the link, and the verdict is
#    honoured. RAN_FOR_REAL on disk is what separates "reported an allow" from
#    "allowed".
run pair-link-allows bash '{"command":"touch RAN_FOR_REAL"}' "$ALLOW" \
  "$(automode_settings '')" "$(perm_config "$ASKS" "$CHAIN_ON")"

# 4. The same path, the other verdict.
run pair-link-denies bash '{"command":"rm -rf CANARY"}' "$BLOCK" \
  "$(automode_settings '')" "$(perm_config "$ASKS" "$CHAIN_ON")"

# 5. A classifier that answers allow on a hard_deny tier is not a valid verdict,
#    and the boundary holds through the chain as it does standalone.
run pair-hard-deny-beats-allow bash '{"command":"rm -rf CANARY"}' "$CONTRA" \
  "$(automode_settings '')" "$(perm_config "$ASKS" "$CHAIN_ON")"

# 6-7. Fail-closed reaches the chain as a deny, not as a defer to a prompt that
#      is not there.
run pair-unparseable-reply bash '{"command":"rm -rf CANARY"}' "$PROSE" \
  "$(automode_settings '')" "$(perm_config "$ASKS" "$CHAIN_ON")"

run pair-provider-error bash '{"command":"rm -rf CANARY"}' error \
  "$(automode_settings '')" "$(perm_config "$ASKS" "$CHAIN_ON")"

# 8. Auto mode's own deny list still bites on a command the permission system
#    would have allowed outright. This is the defence-in-depth the delegated
#    pre-pass exists for, and it costs no model call.
run pair-automode-deny-list bash '{"command":"sudo rm -rf CANARY"}' "$ALLOW" \
  "$(automode_settings ',"permissions":{"deny":["bash(sudo *)"]}')" \
  "$(perm_config "$ALLOWS" "$CHAIN_ON")"

# 9. The same for the deterministic hard-deny checks, which never consult a
#    model and which a permission-system allow must not wave through.
run pair-deterministic-hard-deny bash '{"command":"echo pwned >> $HOME/.bashrc"}' "$ALLOW" \
  "$(automode_settings '')" "$(perm_config "$ALLOWS" "$CHAIN_ON")"

# 10. The control. Identical to case 3 except that nobody named the link, which
#     is the state this project already shipped once. The ask must NOT reach the
#     classifier, and the review log must not credit the link.
run pair-no-chain-entry bash '{"command":"touch RAN_FOR_REAL"}' "$ALLOW" \
  "$(automode_settings '')" "$(perm_config "$ASKS" "$CHAIN_OFF")"
