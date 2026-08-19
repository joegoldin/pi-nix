// End-to-end check of the Nix-packaged pi-intercom broker.
//
// Speaks the 0.10.1 wire protocol directly (4-byte BE length + JSON) so the
// test depends on nothing but the broker itself: no pi, no extension host, no
// node_modules. Proves the store-path bun launcher starts the broker, that the
// socket lands where paths.ts says it will with the modes it promises, that two
// peers can see each other, that a message routes with its body intact, and
// that the hardened broker refuses to hand over a live session's ID.
//
// usage: bun intercom-smoke.mjs <extension package root> <bun executable>

import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [root, bunExe] = process.argv.slice(2);
assert.ok(root, "argv[2] must be the pi-intercom package root");
assert.ok(bunExe, "argv[3] must be the bun executable");

// Hostile umask on purpose. pi-intercom passes explicit modes AND chmods, so
// unlike some of its competitors its permissions must not depend on this.
process.umask(0o002);

const agentDir = mkdtempSync(join(tmpdir(), "intercom-smoke-"));
const sockPath = join(agentDir, "intercom", "broker.sock");

const broker = spawn(bunExe, [join(root, "broker", "broker.ts")], {
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  stdio: ["ignore", "ignore", "inherit"],
});
broker.on("exit", (code, signal) => {
  if (code !== null && code !== 0) {
    console.error(`broker exited early: code=${code} signal=${signal}`);
    process.exit(1);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 200 && !existsSync(sockPath); i++) await sleep(50);
assert.ok(existsSync(sockPath), `broker socket never appeared at ${sockPath}`);

const mode = (p) => (statSync(p).mode & 0o777).toString(8);
assert.equal(mode(join(agentDir, "intercom")), "700", "intercom dir must be 0700");
assert.equal(mode(sockPath), "600", "broker socket must be 0600");
assert.equal(mode(join(agentDir, "intercom", "broker.pid")), "600", "pid file must be 0600");

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
  // the transport is a UDS. The prompt fragment in Task 8 is what tells the
  // model that a sender name is a claim rather than a fact.
  assert.ok(listed.sessions.every((s) => s.peerUid === undefined),
    "peerUid is expected to be unset; if upstream starts setting it, revisit the threat model");

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
  // must be refused. Against the unpatched package the thief is registered and
  // the incumbent's socket is closed.
  let plannerClosed = false;
  planner.raw.on("close", () => { plannerClosed = true; });
  const thief = await connect();
  thief.send({ ...registration("planner", "/repo/api"), sessionId: plannerReg.sessionId });
  const verdict = await thief.until(
    (m) => m.type === "registered" || m.type === "error",
    "thief verdict",
  );
  assert.equal(verdict.type, "error", "claiming a live session ID must be refused, got a registration");
  await sleep(300);
  assert.equal(plannerClosed, false, "the incumbent session's socket must stay open");

  console.log("intercom smoke: 0700/0600 under umask 002, 2 listed, 1 delivered, session-ID takeover refused");
  broker.kill("SIGTERM");
  process.exit(0);
} catch (error) {
  console.error(error);
  broker.kill("SIGKILL");
  process.exit(1);
}
