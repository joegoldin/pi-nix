#!/usr/bin/env bash
# Every behaviour the replacement has to show, against the real pi binary and
# the real pinned extension. Each case picks the classifier's verdict, so the
# input to every branch is chosen rather than hoped for.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ALLOW='{"decision":"allow","tier":"allow","reason":"e2e says allow"}'
BLOCK='{"decision":"block","tier":"soft_deny","reason":"e2e says block"}'
CONTRA='{"decision":"allow","tier":"hard_deny","reason":"e2e contradiction"}'
PROSE='Sure, that looks fine to me!'

base_settings() {
  # $1 = extra autoMode keys (JSON fragment, may be empty)
  cat <<JSON
{"autoMode":{"enabled":true,"classifierModel":"fake/classifier",
"log":{"enabled":true,"classifierIo":true},
"environment":["This is an end-to-end test sandbox."],
"allow":["Reading files inside the working directory is fine."],
"soft_deny":["Deleting files the user did not name."],
"hard_deny":["Never read private SSH keys or other credentials."]$1}}
JSON
}

run() { # name, tool, input json, classifier text, settings
  echo
  echo "############ $1"
  bash ./run-case.sh "$1" "$2" "$3" "$4" "$5"
}

run allow-in-tree read '{"path":"CANARY"}' "$ALLOW" \
  "$(base_settings ',"allowInsideWorkingDirectory":true')"

run allow-read-only-fast-path read '{"path":"CANARY"}' "$ALLOW" \
  "$(base_settings '')"

# permissions.* is a top-level key beside autoMode, not inside it.
PERM_DENY='{"autoMode":{"enabled":true,"classifierModel":"fake/classifier","log":{"enabled":true},"hard_deny":["Never read credentials."]},"permissions":{"deny":["bash(rm -rf *)"]}}'
PERM_ASK='{"autoMode":{"enabled":true,"classifierModel":"fake/classifier","log":{"enabled":true},"hard_deny":["Never read credentials."]},"permissions":{"ask":["bash(rm -rf *)"]}}'

run permissions-deny bash '{"command":"rm -rf CANARY"}' "$ALLOW" \
  "$PERM_DENY"

run permissions-ask-no-ui bash '{"command":"rm -rf CANARY"}' "$ALLOW" \
  "$PERM_ASK"

run deterministic-hard-deny bash '{"command":"echo pwned >> $HOME/.bashrc"}' "$ALLOW" \
  "$(base_settings '')"

run denied-path read '{"path":"CANARY"}' "$ALLOW" \
  "$(base_settings ',"deniedPaths":["*CANARY"],"allowInsideWorkingDirectory":true')"

run classifier-blocks bash '{"command":"rm -rf CANARY"}' "$BLOCK" \
  "$(base_settings '')"

run classifier-allows bash '{"command":"touch RAN_FOR_REAL"}' "$ALLOW" \
  "$(base_settings '')"

run hard-deny-beats-allow bash '{"command":"rm -rf CANARY"}' "$CONTRA" \
  "$(base_settings '')"

run unparseable-reply bash '{"command":"rm -rf CANARY"}' "$PROSE" \
  "$(base_settings '')"

run provider-error bash '{"command":"rm -rf CANARY"}' error \
  "$(base_settings '')"

run compound-command bash '{"command":"git status --short && rm -rf CANARY"}' "$BLOCK" \
  "$(base_settings '')"

run enabled-by-default bash '{"command":"rm -rf CANARY"}' "$BLOCK" \
  '{"autoMode":{"classifierModel":"fake/classifier","log":{"enabled":true},"hard_deny":["Never read credentials."]}}'
