import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [modules, extension] = process.argv.slice(2);
const { resolveHostPeerAliases } = await import(pathToFileURL(join(
  extension, "src/runs/background/runner-aliases.js",
)));
const { aliases, missing } = resolveHostPeerAliases(join(modules, "@earendil-works/pi-coding-agent"));
assert.deepEqual(missing, [], "Background workers must resolve every required host peer");
for (const target of Object.values(aliases)) await import(pathToFileURL(target));
console.log(`Resolved and imported ${Object.keys(aliases).length} background-worker host peers`);
