import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [extension, modules] = process.argv.slice(2);
const root = await mkdtemp(join(tmpdir(), "pi-web-smoke-"));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
await mkdir(process.env.PI_CODING_AGENT_DIR);
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Smoke checks must not make external requests"); };
try {
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(modules, "@earendil-works/pi-coding-agent/dist/index.js")).href);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ extensions: ["-builtin:mcp"] }), additionalExtensionPaths: [extension] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const tools = loader.getExtensions().extensions.flatMap(ext => [...ext.tools.values()].map(tool => tool.definition));
  for (const name of ["web_search", "source_check", "fetch_content", "get_search_content"]) {
    assert(tools.some(tool => tool.name === name), `Missing ${name}`);
  }
  const fetch = tools.find(tool => tool.name === "fetch_content");
  assert(!fetch.parameters.properties.fields, "Cloudflare extraction must stay opt-in");
  console.log("Web tools load under Pi1.4 without network; extraction remains opt-in");
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
