#!/usr/bin/env bash
# One case with BOTH gates loaded: @czottmann/pi-automode (our fork) and
# @gotgenes/pi-permission-system, against the real pi binary.
#
# run-case.sh proves what auto mode does on its own. This proves what the two
# do together, which is a different claim and the one that was doubted: that
# the permission system's deterministic engine still resolves what it can
# without a model call, and that what it cannot resolve reaches auto mode's
# classifier as an authorizer-chain link instead of a dialog.
#
# The evidence is the permission system's own review log. Its `decidedBy` field
# names the decider at the site that decided, so "the chain link ruled" and "the
# user ruled at a dialog" are distinguishable facts rather than an inference
# from an event name.
set -uo pipefail

E2E="${E2E_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
WORKDIR="${E2E_WORK:-/tmp/pi-am-e2e}"
NAME="$1"; shift
TOOL="$1"; shift
INPUT_JSON="$1"; shift
CLASSIFIER_TEXT="$1"; shift
SETTINGS_JSON="$1"; shift
PERM_CONFIG_JSON="$1"; shift

PI="${PI_STORE_PATH:-$(nix build --no-link --print-out-paths "$E2E/../..#coding-agent-bun" | tail -1)}"
EXT="${EXT_STORE_PATH:-$(nix build --no-link --print-out-paths "$E2E/../..#ext-czottmann-pi-automode" | tail -1)}"
PERM="${PERM_STORE_PATH:-$(nix build --no-link --print-out-paths "$E2E/../..#ext-gotgenes-pi-permission-system" | tail -1)}"

RUN="$WORKDIR/runs/$NAME"
rm -rf "$RUN"; mkdir -p "$RUN/home" "$RUN/agent" "$RUN/work"
export E2E_DIR="$RUN"
export E2E_PORT=8231
TOOL="$TOOL" INPUT_JSON="$INPUT_JSON" CLASSIFIER_TEXT="$CLASSIFIER_TEXT" RUN="$RUN" python3 - <<'PY'
import json, os
case = {
    "tool": os.environ["TOOL"],
    "input": json.loads(os.environ["INPUT_JSON"]),
    "classifier": os.environ["CLASSIFIER_TEXT"],
}
open(os.environ["RUN"] + "/case.json", "w").write(json.dumps(case))
PY
: > "$RUN/requests.jsonl"
echo "canary" > "$RUN/work/CANARY"
# A real repository, so `git status` is the command the operator actually
# complained about rather than an approximation of it.
git -C "$RUN/work" init -q 2>/dev/null

# The permission system's own config file, at the path it reads it from:
# $PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json. In the real
# stack pi-nix writes this through passthru.configFiles; here the case supplies
# it, because the point under test is what the file's contents do.
mkdir -p "$RUN/agent/extensions/pi-permission-system"
printf '%s\n' "$PERM_CONFIG_JSON" > "$RUN/agent/extensions/pi-permission-system/config.json"

cat > "$RUN/agent/models.json" <<JSON
{
  "providers": {
    "fake": {
      "name": "fake",
      "baseUrl": "http://127.0.0.1:8231/v1",
      "apiKey": "e2e-key",
      "api": "openai-completions",
      "models": [
        { "id": "session", "name": "session", "reasoning": false, "input": ["text"],
          "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0},
          "contextWindow": 200000, "maxTokens": 8192 },
        { "id": "classifier", "name": "classifier", "reasoning": false, "input": ["text"],
          "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0},
          "contextWindow": 200000, "maxTokens": 8192 }
      ]
    }
  }
}
JSON
echo '{}' > "$RUN/agent/auth.json"

bun "$E2E/server.ts" > "$RUN/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 50); do
  curl -s -o /dev/null -m 1 http://127.0.0.1:8231/v1 && break
  sleep 0.1
done

# Auto mode FIRST, which is the order coding-agent/extra-options.nix builds:
# its handler has to see the tool call before the permission system turns it
# into an ask, so the chain link reviews the real event and the real input.
cd "$RUN/work"
timeout 180 env -i \
  HOME="$RUN/home" \
  PATH="/run/current-system/sw/bin:/usr/bin:/bin" \
  TERM=dumb \
  PI_CODING_AGENT_DIR="$RUN/agent" \
  PI_AUTOMODE_SETTINGS_JSON="$SETTINGS_JSON" \
  "$PI/bin/pi" --print --model fake/session \
    --extension "$EXT" --extension "$PERM" \
    --session-dir "$RUN/sessions" \
    "run the tool" < /dev/null > "$RUN/pi.stdout" 2> "$RUN/pi.stderr"
echo "pi exit: $?" >> "$RUN/pi.stdout"

kill $SRV 2>/dev/null
wait $SRV 2>/dev/null

python3 - "$RUN" <<'PY'
import json, sys, os, glob
run = sys.argv[1]
roles = [json.loads(line)["role"] for line in open(f"{run}/requests.jsonl")]
print("PROVIDER CALLS:", roles)
print("CLASSIFIER CONSULTED:", "yes" if "CLASSIFIER" in roles else "no")
print("CANARY:", "STILL THERE" if os.path.exists(f"{run}/work/CANARY") else "GONE")

for f in glob.glob(f"{run}/sessions/**/*-pi-automode.jsonl", recursive=True):
    for line in open(f):
        e = json.loads(line)
        if e.get("type") == "decision":
            print(f"  automode: kind={e['kind']} outcome={e['outcome']} tool={e['tool']}")
            print(f"    reason: {e['reason'][:160]}")

# What pi actually fed back to the model: the only place the blocker names
# itself, and the difference between "reported a block" and "blocked".
for f in glob.glob(f"{run}/sessions/*.jsonl"):
    for line in open(f):
        message = json.loads(line).get("message", {})
        if message.get("role") != "toolResult":
            continue
        text = " ".join(c.get("text", "") for c in message.get("content", []))
        print(f"TOOL RESULT ({'error' if message.get('isError') else 'ok'}): {text[:200]}")

review = f"{run}/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl"
if not os.path.exists(review):
    print("REVIEW LOG: NONE")
else:
    for line in open(review):
        e = json.loads(line)
        if "decidedBy" in e:
            print(f"  review: event={e.get('event')} surface={e.get('surface')} "
                  f"value={str(e.get('value'))[:60]!r}")
            print(f"    decidedBy: {json.dumps(e['decidedBy'])}")
        elif e.get("event", "").startswith("authorizer_chain"):
            print(f"  review: {e['event']} {json.dumps({k: v for k, v in e.items() if k in ('links', 'name')})}")
PY
echo "WORK:" $(ls "$RUN/work" | tr '\n' ' ')
echo "--- pi stdout ---"
tail -12 "$RUN/pi.stdout"
