#!/usr/bin/env bash
# Verifies design assumption A9: a broker started inside one bubblewrap jail
# stays reachable from a second, differently-mounted jail, because both bind the
# same $PI_CODING_AGENT_DIR from the host.
#
# This cannot be a Nix check: bubblewrap needs user namespaces the build sandbox
# does not grant. It is a real script run on the host.
#
# usage: ./scripts/verify-jail-socket.sh
set -euo pipefail

cd "$(dirname "$0")/.."

ROOT=$(nix eval --raw .#ext-pi-intercom)
BUN=$(nix build --no-link --print-out-paths nixpkgs#bun)/bin/bun

AGENT_DIR=$(mktemp -d /tmp/pi-jail-a9.XXXXXX)
CWD_A=$(mktemp -d /tmp/pi-jail-a9-a.XXXXXX)
CWD_B=$(mktemp -d /tmp/pi-jail-a9-b.XXXXXX)
trap 'rm -rf "$AGENT_DIR" "$CWD_A" "$CWD_B"' EXIT

SOCK="$AGENT_DIR/intercom/broker.sock"

jail() {
  local cwd="$1"; shift
  # --tmpfs /tmp comes FIRST. bwrap applies mount arguments in order, and the
  # scratch dirs live under /tmp, so a later tmpfs would mask the binds that
  # make this test mean anything.
  bwrap \
    --ro-bind /nix /nix \
    --proc /proc --dev /dev --tmpfs /tmp \
    --bind "$AGENT_DIR" "$AGENT_DIR" \
    --bind "$cwd" "$cwd" \
    --unshare-net --unshare-pid --die-with-parent \
    --setenv PI_CODING_AGENT_DIR "$AGENT_DIR" \
    --setenv HOME "$AGENT_DIR" \
    --chdir "$cwd" \
    "$@"
}

# Jail A: run the broker.
jail "$CWD_A" "$BUN" "$ROOT/broker/broker.ts" &
BROKER_JAIL=$!

for _ in $(seq 1 200); do
  [ -S "$SOCK" ] && break
  sleep 0.1
done
[ -S "$SOCK" ] || { echo "FAIL: socket never appeared at $SOCK"; exit 1; }
echo "ok: broker in jail A bound $SOCK ($(stat -c '%a' "$SOCK"))"

# Jail B: a different cwd bind, same agent dir. It must be able to register.
jail "$CWD_B" "$BUN" -e '
  const net = await import("node:net");
  const s = net.connect(process.env.PI_CODING_AGENT_DIR + "/intercom/broker.sock");
  const write = (m) => {
    const j = JSON.stringify(m), n = Buffer.byteLength(j, "utf-8");
    const f = Buffer.allocUnsafe(4 + n); f.writeUInt32BE(n, 0); f.write(j, 4, n, "utf-8");
    s.write(f);
  };
  s.on("connect", () => write({ type: "register", session: {
    name: "jail-b", cwd: process.cwd(), model: "m", pid: process.pid,
    startedAt: Date.now(), lastActivity: Date.now() } }));
  s.on("data", (d) => {
    const msg = JSON.parse(d.subarray(4, 4 + d.readUInt32BE(0)).toString("utf-8"));
    if (msg.type === "registered") { console.log("ok: jail B registered as", msg.sessionId); process.exit(0); }
    console.error("FAIL: unexpected", msg); process.exit(1);
  });
  setTimeout(() => { console.error("FAIL: no reply from broker across jails"); process.exit(1); }, 10000);
'

kill "$BROKER_JAIL" 2>/dev/null || true
echo "A9 HOLDS: a broker in one jail is reachable from another"
