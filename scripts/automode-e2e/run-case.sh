#!/usr/bin/env bash
# One case: start the fake provider, run the real pi against it with the real
# extension and a Nix-shaped PI_AUTOMODE_SETTINGS_JSON, then report what pi fed
# back to the model and whether the classifier was consulted.
set -uo pipefail

E2E="${E2E_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
WORKDIR="${E2E_WORK:-/tmp/pi-am-e2e}"
NAME="$1"; shift
TOOL="$1"; shift
INPUT_JSON="$1"; shift
CLASSIFIER_TEXT="$1"; shift
SETTINGS_JSON="$1"; shift

# Built here rather than passed in, so a stale path cannot make a green run
# meaningless.
PI="${PI_STORE_PATH:-$(nix build --no-link --print-out-paths "$E2E/../..#coding-agent-bun" | tail -1)}"
EXT="${EXT_STORE_PATH:-$(nix build --no-link --print-out-paths "$E2E/../..#ext-czottmann-pi-automode" | tail -1)}"

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

# Canary: any case whose command deletes it proves the block was real.
echo "canary" > "$RUN/work/CANARY"

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

cd "$RUN/work"
timeout 120 env -i \
  HOME="$RUN/home" \
  PATH="/run/current-system/sw/bin:/usr/bin:/bin" \
  TERM=dumb \
  PI_CODING_AGENT_DIR="$RUN/agent" \
  PI_AUTOMODE_SETTINGS_JSON="$SETTINGS_JSON" \
  "$PI/bin/pi" --print --model fake/session --extension "$EXT" \
    --session-dir "$RUN/sessions" \
    "run the tool" < /dev/null > "$RUN/pi.stdout" 2> "$RUN/pi.stderr"
echo "pi exit: $?" >> "$RUN/pi.stdout"

kill $SRV 2>/dev/null
wait $SRV 2>/dev/null

python3 - "$RUN" <<'PY'
import json, sys, os, glob
run = sys.argv[1]
roles = []
for line in open(f"{run}/requests.jsonl"):
    roles.append(json.loads(line)["role"])
print("PROVIDER CALLS:", roles)
print("CANARY:", "STILL THERE" if os.path.exists(f"{run}/work/CANARY") else "GONE")
logs = glob.glob(f"{run}/sessions/**/*-pi-automode.jsonl", recursive=True)
print("AUTOMODE LOG:", logs[0] if logs else "NONE")
for f in logs:
    for line in open(f):
        e = json.loads(line)
        if e.get("type") == "decision":
            print(f"  decision: kind={e['kind']} outcome={e['outcome']} tool={e['tool']}")
            print(f"  reason: {e['reason'][:180]}")
PY
echo "WORK:" $(ls "$RUN/work" | tr '\n' ' ')
echo "--- pi stdout ---"
tail -20 "$RUN/pi.stdout"
