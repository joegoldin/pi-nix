// Grammars must work from a read-only Nix package without runtime downloads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
assert(root, "usage: pi-lens-grammars <installed pi-lens>");
const manifest = JSON.parse(readFileSync(join(root, "scripts/grammars.lock.json"), "utf8"));
const swift = join(root, "grammars/tree-sitter-swift.wasm");
assert(existsSync(swift), "Swift grammar must be bundled, not fetched into the Nix store");
for (const [name, hash] of Object.entries(manifest.grammars)) {
  const data = readFileSync(join(root, "grammars", name));
  assert.equal(`sha256:${createHash("sha256").update(data).digest("hex")}`, hash, name);
}
for (const [name, metadata] of Object.entries(manifest.vendored)) {
  const data = readFileSync(join(root, "vendor/grammars", name));
  assert.equal(`sha256:${createHash("sha256").update(data).digest("hex")}`, metadata.sha256, name);
}
globalThis.fetch = () => { throw new Error("Grammar loading must not fetch at runtime"); };
const { Parser, Language } = await import(pathToFileURL(join(root, "node_modules/web-tree-sitter/tree-sitter.js")).href);
await Parser.init({ locateFile: (name) => join(root, "node_modules/web-tree-sitter", name) });
for (const [directory, names] of [["grammars", Object.keys(manifest.grammars)], ["vendor/grammars", Object.keys(manifest.vendored)]]) {
  const probe = new Parser();
  for (const name of names) probe.setLanguage(await Language.load(join(root, directory, name)));
  probe.delete();
}
const language = await Language.load(swift);
const parser = new Parser();
parser.setLanguage(language);
const tree = parser.parse('struct Greeting { func sayHello() -> String { return "hello" } }');
assert(!tree.rootNode.hasError, tree.rootNode.toString());
assert(tree.rootNode.descendantsOfType("function_declaration").some(node => node.text.includes("sayHello")));
tree.delete();
parser.delete();
console.log(`Verified ${Object.keys(manifest.grammars).length} pinned grammars and parsed Swift without network access.`);
