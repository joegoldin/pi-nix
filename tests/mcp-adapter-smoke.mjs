// Exercise the installed adapter through Pi's real extension loader, without a
// model, credentials, or external servers. Both MCP config formats stay intact.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [adapter, piModules] = process.argv.slice(2);
assert(adapter && piModules, "usage: smoke <adapter> <pi node_modules>");
// Both the extension source and the public JS API keep model-assisted features opt-in.
for (const file of ["semantic-settings.ts", "dist/semantic-settings.js"]) {
  const { validateSemanticSearchSettings } = await import(pathToFileURL(join(adapter, file)).href);
  assert.equal(validateSemanticSearchSettings(undefined).enabled, false);
  assert.equal(validateSemanticSearchSettings(false).enabled, false);
  assert.equal(validateSemanticSearchSettings({ allowedServers: ["local"] }).enabled, true);
}
const { validateExtractionSettings } = await import(pathToFileURL(join(adapter, "dist/extraction-settings.js")).href);
assert.equal(validateExtractionSettings(undefined).enabled, false);
const root = await mkdtemp(join(tmpdir(), "pi-mcp-smoke-"));
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = join(root, ".config");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const cwd = join(root, "project");
await mkdir(cwd);
await mkdir(process.env.PI_CODING_AGENT_DIR);
const server = join(root, "server.mjs");
await writeFile(server, `
import readline from "node:readline";
readline.createInterface({input: process.stdin}).on("line", line => {
  const q = JSON.parse(line);
  if (q.id === undefined) return;
  let result;
  if (q.method === "initialize") result = {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}};
  else if (q.method === "tools/list") result = {tools:[{name:"echo",description:"Echo fixture",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}]};
  else if (q.method === "tools/call") result = {content:[{type:"text",text:q.params.arguments.text}]};
  process.stdout.write(JSON.stringify(result === undefined ? {jsonrpc:"2.0",id:q.id,error:{code:-32601,message:"Unsupported method"}} : {jsonrpc:"2.0",id:q.id,result})+"\\n");
});
`);
const definition = { command: process.execPath, args: [server], protocolVersion: "legacy" };
const native = join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
const shared = join(cwd, ".mcp.json");
await writeFile(native, JSON.stringify({ mcpServers: { native: { command: process.execPath, args: [server] } } }));
await writeFile(shared, JSON.stringify({ mcpServers: { local: definition } }));
const originals = await Promise.all([native, shared].map(p => readFile(p, "utf8")));
// Trust only these throwaway project fixtures; production keeps the adapter's
// normal first-connection approval. No config or command from the user is read.
await writeFile(join(process.env.PI_CODING_AGENT_DIR, "mcp-adapter.json"), JSON.stringify({ settings: { projectServers: "allow", sampling: false, elicitation: false } }));
await writeFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"], defaultTools: ["+codemode"] }));
const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } = await import(pathToFileURL(join(piModules, "@earendil-works/pi-coding-agent/dist/index.js")).href);
const settingsManager = SettingsManager.inMemory({ extensions: ["-builtin:mcp"], defaultTools: ["+codemode"] });
const loader = new DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, additionalExtensionPaths: [adapter], extensionFactories: [{ name: "codemode", builtin: true, factory: createCodemodeExtension() }] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
assert(!loader.getExtensions().extensions.some(e => e.path === "builtin:mcp"));
const { session } = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager });
// The CLI applies defaultTools after SDK session creation; mirror that step.
session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
const errors = [];
try {
  await session.bindExtensions({ mode: "print", onError: e => errors.push(e.error) });
  const runner = session.extensionRunner;
  const tools = runner.getAllRegisteredTools().map(t => t.definition);
  assert.equal(tools.filter(t => t.name === "mcp").length, 1);
  assert(session.getActiveToolNames().includes("codemode"));
  const proxy = tools.find(t => t.name === "mcp");
  assert(!proxy.parameters.properties.extract, "Unconfigured extraction must remain unavailable");
  for (const name of ["native", "local"]) {
    const result = await proxy.execute(`test-${name}`, { server: name, tool: "echo", args: { text: `${name} works` } }, undefined, undefined, runner.createContext());
    assert(!result.isError, JSON.stringify(result));
    assert(JSON.stringify(result.content).includes(`${name} works`), JSON.stringify(result));
  }
  const codemode = tools.find(t => t.name === "codemode");
  const script = { code: 'text(await tools.mcp({ server: "local", tool: "echo", args: { text: "codemode works" } }));' };
  // Supply the issuing assistant turn without making a provider request.
  session.agent.state.messages = [...session.agent.state.messages, { role: "assistant", content: [{ type: "toolCall", id: "test-codemode", name: "codemode", arguments: script }], stopReason: "toolUse", timestamp: Date.now() }];
  const scripted = await codemode.execute("test-codemode", script, undefined, undefined, runner.createToolContext("test-codemode", undefined));
  assert(!scripted.isError, JSON.stringify(scripted));
  assert(JSON.stringify(scripted.content).includes("codemode works"), JSON.stringify(scripted));
  assert.deepEqual(errors, []);
  assert.deepEqual(await Promise.all([native, shared].map(p => readFile(p, "utf8"))), originals);
  console.log("MCP adapter: native and local config calls pass; one client, codemode active, source configs unchanged.");
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
