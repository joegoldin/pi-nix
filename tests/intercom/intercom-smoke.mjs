// End-to-end check of the broker pi-custom ships.
//
// Starts the broker through spawn.ts with a bun store path as brokerCommand,
// which is how pi-custom launches it under the messaging option, then speaks
// the wire protocol directly (4-byte BE length + JSON) so the rest of the test
// depends on nothing but the broker itself: no pi, no extension host, no
// node_modules. Proves the socket lands where paths.ts says it will with the
// modes it promises, that two peers can see each other, that a message routes
// with its body intact, and that the broker refuses to hand over a live
// session's ID.
//
// usage: bun intercom-smoke.mjs <pi-custom package root> <bun executable>

import assert from "node:assert/strict";
import net from "node:net";
import { existsSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [root, bunExe] = process.argv.slice(2);
assert.ok(root, "argv[2] must be the pi-custom package root");
assert.ok(bunExe, "argv[3] must be the bun executable");

// Hostile umask on purpose. The broker and spawn.ts pass explicit modes AND
// chmod, so the permissions must not depend on this.
process.umask(0o002);

const agentDir = mkdtempSync(join(tmpdir(), "intercom-smoke-"));
const intercomDir = join(agentDir, "intercom");
const sockPath = join(intercomDir, "broker.sock");
const pidPath = join(intercomDir, "broker.pid");
// spawn.ts and paths.ts read the agent dir from the environment at call time.
process.env.PI_CODING_AGENT_DIR = agentDir;

const { spawnBrokerIfNeeded } = await import(join(root, "src", "intercom", "broker", "spawn.ts"));

// spawn.ts detaches the broker so it outlives the pi that started it; this
// kills it by its pid file so the build does not wait out its idle timer.
function stopBroker(signal) {
  try {
    process.kill(Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10), signal);
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await spawnBrokerIfNeeded(bunExe, []);
} catch (error) {
  console.error(error);
  process.exit(1);
}
assert.ok(existsSync(sockPath), `broker socket never appeared at ${sockPath}`);

const mode = (p) => (statSync(p).mode & 0o777).toString(8);
assert.equal(mode(intercomDir), "700", "intercom dir must be 0700");
assert.equal(mode(sockPath), "600", "broker socket must be 0600");
assert.equal(mode(pidPath), "600", "pid file must be 0600");

function writeMessage(socket, msg) {
  const json = JSON.stringify(msg);
  const len = Buffer.byteLength(json, "utf-8");
  const frame = Buffer.allocUnsafe(4 + len);
  frame.writeUInt32BE(len, 0);
  frame.write(json, 4, len, "utf-8");
  socket.write(frame);
}

function connect() {
  return new Promise((resolve) => {
    const socket = net.connect(sockPath);
    const inbox = [];
    const waiters = [];
    let buf = Buffer.alloc(0);
    const drain = () => {
      for (let i = 0; i < waiters.length; ) {
        const idx = inbox.findIndex(waiters[i].pred);
        if (idx === -1) { i += 1; continue; }
        const [msg] = inbox.splice(idx, 1);
        waiters.splice(i, 1)[0].resolve(msg);
      }
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) break;
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        inbox.push(JSON.parse(buf.subarray(4, 4 + len).toString("utf-8")));
        buf = buf.subarray(4 + len);
      }
      drain();
    });
    socket.on("connect", () =>
      resolve({
        raw: socket,
        send: (m) => writeMessage(socket, m),
        // The broker interleaves session_joined broadcasts with replies, so
        // every wait is predicate-based, never positional.
        until: (pred, label, timeoutMs = 8000) =>
          new Promise((res, rej) => {
            const w = { pred, resolve: res };
            waiters.push(w);
            drain();
            setTimeout(() => {
              const i = waiters.indexOf(w);
              if (i !== -1) {
                waiters.splice(i, 1);
                rej(new Error(`timed out waiting for ${label}; inbox=${JSON.stringify(inbox)}`));
              }
            }, timeoutMs);
          }),
      }),
    );
  });
}

const registration = (name, cwd) => ({
  type: "register",
  session: {
    name,
    cwd,
    model: "smoke-test-model",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  },
});

try {
  const planner = await connect();
  planner.send(registration("planner", "/repo/api"));
  const plannerReg = await planner.until((m) => m.type === "registered", "planner registered");
  assert.equal(typeof plannerReg.sessionId, "string");

  const worker = await connect();
  worker.send(registration("worker", "/repo/web"));
  await worker.until((m) => m.type === "registered", "worker registered");

  // ListAgents equivalent.
  planner.send({ type: "list", requestId: "smoke-1" });
  const listed = await planner.until((m) => Array.isArray(m.sessions), "sessions reply");
  assert.deepEqual(
    listed.sessions.map((s) => s.name).sort(),
    ["planner", "worker"],
    "both sessions must be visible to each other",
  );
  // Recorded, not asserted as a defect: the broker sets no peer credentials, so
  // every entry carries peerUid undefined and trustedLocal true purely because
  // the transport is a UDS. The untrusted-peer prompt fragment is what tells the
  // model that a sender name is a claim rather than a fact.
  assert.ok(listed.sessions.every((s) => s.peerUid === undefined),
    "peerUid is expected to be unset; if the broker starts setting it, revisit the threat model");

  // SendMessage equivalent.
  const messageId = "smoke-message-1";
  const text = "Task-3: add retry logic to the API client.";
  planner.send({
    type: "send",
    to: "worker",
    message: { id: messageId, timestamp: Date.now(), content: { text } },
  });
  const inbound = await worker.until(
    (m) => m.type === "message" && m.message?.id === messageId,
    "inbound message",
  );
  assert.equal(inbound.message.content.text, text, "message body must survive routing");

  // Hardening regression, addendum §17.9 Risk 2: claiming a live session's ID
  // must be refused, and the incumbent must keep its socket.
  let plannerClosed = false;
  planner.raw.on("close", () => { plannerClosed = true; });
  const thief = await connect();
  thief.send({ ...registration("planner", "/repo/api"), sessionId: plannerReg.sessionId });
  const verdict = await thief.until(
    (m) => m.type === "registered" || m.type === "error",
    "thief verdict",
  );
  assert.equal(verdict.type, "error", "claiming a live session ID must be refused, got a registration");
  assert.equal(verdict.error, "Session ID already held by a live session");
  await sleep(300);
  assert.equal(plannerClosed, false, "the incumbent session's socket must stay open");

  console.log("intercom smoke: 0700/0600 under umask 002, 2 listed, 1 delivered, session-ID takeover refused");
  stopBroker("SIGTERM");
  process.exit(0);
} catch (error) {
  console.error(error);
  stopBroker("SIGKILL");
  process.exit(1);
}
