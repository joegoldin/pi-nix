import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The example's Zod 3 range has no patched release. Check its actual schemas
// against our Zod 4 override without starting a sandbox or changing policy.
const require = createRequire(join(process.cwd(), "package.json"));
const entry = require.resolve("@anthropic-ai/sandbox-runtime");
const sandboxRequire = createRequire(entry);
assert.equal(JSON.parse(readFileSync(sandboxRequire.resolve("zod/package.json"), "utf8")).version, "4.6.6");
const { SandboxRuntimeConfigSchema: schema } = await import(pathToFileURL(join(dirname(entry), "sandbox/sandbox-config.js")));
const valid = {
  network: { allowedDomains: ["github.com", "*.npmjs.org"], deniedDomains: ["blocked.example"] },
  filesystem: { denyRead: ["/private"], allowWrite: ["/work"], denyWrite: ["/work/keys"] },
  ignoreViolations: { "example-command": ["/example/path"] },
};
assert.deepEqual(schema.parse(valid), valid);
for (const domain of ["*", "*.com", "https://github.com", "github.com:443", 42]) {
  assert.equal(schema.safeParse({ ...valid, network: { ...valid.network, allowedDomains: [domain] } }).success, false);
}
for (const port of [0, 65536, 1.5, "8080"]) {
  assert.equal(schema.safeParse({ ...valid, network: { ...valid.network, httpProxyPort: port } }).success, false);
}
assert.equal(schema.safeParse({ ...valid, filesystem: { ...valid.filesystem, denyRead: [""] } }).success, false);
assert.equal(schema.safeParse({ ...valid, allowPty: "false" }).success, false);
assert.equal(schema.safeParse({ ...valid, ignoreViolations: { command: 3 } }).success, false);
console.log("Sandbox example schemas preserve domain, filesystem, port, boolean and record validation with patched Zod");
