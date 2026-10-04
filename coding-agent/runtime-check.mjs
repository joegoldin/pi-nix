import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const modules = process.argv[2];
const agent = join(modules, "@earendil-works/pi-coding-agent");
const require = createRequire(join(agent, "package.json"));

for (const name of [
  "typescript", "vitest", "shx", "braces", "node-forge", "@earendil-works/gondolin", "canvas",
]) {
  assert(!existsSync(join(modules, name)), `Build/example dependency shipped: ${name}`);
}
for (const file of [
  "README.md", "CHANGELOG.md", "docs", "examples",
  "dist/modes/interactive/theme/dark.json", "dist/core/export-html/template.html",
]) {
  assert(existsSync(join(agent, file)), `Missing package asset: ${file}`);
}

await import(pathToFileURL(join(agent, "dist/index.js")));
const { loadExtensions } = await import(pathToFileURL(join(agent, "dist/core/extensions/loader.js")));
const extensionDir = mkdtempSync(join(tmpdir(), "pi-extension-check-"));
try {
  const extension = join(extensionDir, "extension.ts");
  writeFileSync(extension, `
    export default function(pi: any) {
      pi.registerCommand("packaging-check", { description: "Test", handler: async () => {} });
    }
  `);
  const loaded = await loadExtensions([extension], extensionDir);
  assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
  assert.equal(loaded.extensions.length, 1);
} finally {
  rmSync(extensionDir, { recursive: true });
}

const { CodemodeSandbox } = await import(pathToFileURL(join(modules, "@earendil-works/pi-codemode/dist/index.js")));
const result = await new CodemodeSandbox().execute("return 6 * 7;");
assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.value, 42);
require("esbuild").transformSync("const value: number = 1", { loader: "ts" });
require("@silvia-odwyer/photon-node");

const native = join(
  modules, "@earendil-works/pi-tui/native", process.platform,
  "prebuilds", `${process.platform}-${process.arch}`,
);
if (existsSync(native)) {
  for (const file of readdirSync(native)) {
    if (file.endsWith(".node")) require(join(native, file));
  }
}
