// Exercise the packaged plugin through Pi's real loader and request hook.
// No prompt or provider call is made; neither credentials nor paid inference are needed.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [extension, modules] = process.argv.slice(2);
const root = await mkdtemp(join(tmpdir(), "pi-fast-smoke-"));
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = join(root, ".config");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
await mkdir(process.env.PI_CODING_AGENT_DIR);
const load = (path) => import(pathToFileURL(join(modules, path)).href);
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = await load("@earendil-works/pi-coding-agent/dist/index.js");
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const settingsManager = SettingsManager.inMemory({ extensions: ["-builtin:mcp"] });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, additionalExtensionPaths: [extension] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const sessionManager = SessionManager.inMemory(root);
const model = modelRuntime.getModel("openai", "gpt-5.4");
assert(model);
const { session } = await createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, sessionManager, settingsManager, modelRuntime, model });
const errors = [];
try {
  await session.bindExtensions({ mode: "print", onError: (event) => errors.push(event.error) });
  const runner = session.extensionRunner;
  const command = runner.getCommand("fast");
  assert(command, "packaged plugin registers /fast");
  const payload = { model: model.id, input: [], stream: true };
  assert.deepEqual(await runner.emitBeforeProviderRequest(payload), payload);
  await command.handler("on", runner.createCommandContext());
  assert.deepEqual(await runner.emitBeforeProviderRequest(payload), { ...payload, service_tier: "priority" });
  assert.equal(payload.service_tier, undefined, "the provider's original payload is not mutated");
  assert(sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-fast:state" && entry.data.enabled === true));
  await runner.emit({ type: "session_start", reason: "resume" });
  assert.equal((await runner.emitBeforeProviderRequest(payload)).service_tier, "priority");
  await command.handler("off", runner.createCommandContext());
  assert.deepEqual(await runner.emitBeforeProviderRequest(payload), payload);
  assert.deepEqual(errors, []);
  console.log("pi-fast: packaged /fast, priority request override, branch persistence and off pass through the real SDK; no inference called.");
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
