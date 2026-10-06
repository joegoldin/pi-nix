import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertNoLiveBroker,
	ensureIntercomRuntimeDir,
	getAgentDirPath,
	getBrokerSocketPath,
	getIntercomDirPath,
	getIntercomScopeId,
	INTERCOM_DIR_MODE,
	INTERCOM_RUNTIME_FILE_MODE,
	restrictIntercomRuntimeFile,
	sameCwd,
} from "./paths.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-intercom-paths-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("locations", () => {
	it("defaults the agent dir to ~/.pi/agent", () => {
		expect(getAgentDirPath({}, "/home/u")).toBe(join("/home/u", ".pi/agent"));
	});

	it("honours PI_CODING_AGENT_DIR, resolving a relative one from the caller's cwd", () => {
		expect(getAgentDirPath({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" }, "/home/u")).toBe("/tmp/pi-agent");
		expect(getAgentDirPath({ PI_CODING_AGENT_DIR: "rel" }, "/home/u", "/work/project")).toBe("/work/project/rel");
	});

	it("puts the socket at <agent dir>/intercom/broker.sock", () => {
		expect(getIntercomDirPath("/tmp/pi-agent")).toBe("/tmp/pi-agent/intercom");
		expect(getBrokerSocketPath("/tmp/pi-agent")).toBe("/tmp/pi-agent/intercom/broker.sock");
	});

	it("reads the scope from PI_INTERCOM_SCOPE_ID, ignoring blank values", () => {
		expect(getIntercomScopeId({ PI_INTERCOM_SCOPE_ID: " team-a " })).toBe("team-a");
		expect(getIntercomScopeId({ PI_INTERCOM_SCOPE_ID: "  " })).toBeUndefined();
		expect(getIntercomScopeId({})).toBeUndefined();
	});
});

describe("permissions", () => {
	it("creates the runtime dir 0700 and repairs a loosened one", () =>
		withTempDir((root) => {
			const dir = join(root, "intercom");
			ensureIntercomRuntimeDir(dir);
			expect(statSync(dir).mode & 0o777).toBe(INTERCOM_DIR_MODE);
			chmodSync(dir, 0o755);
			ensureIntercomRuntimeDir(dir);
			expect(statSync(dir).mode & 0o777).toBe(INTERCOM_DIR_MODE);
		}));

	it("restricts runtime files to 0600", () =>
		withTempDir((root) => {
			const file = join(root, "broker.pid");
			writeFileSync(file, "123", { mode: 0o644 });
			restrictIntercomRuntimeFile(file);
			expect(statSync(file).mode & 0o777).toBe(INTERCOM_RUNTIME_FILE_MODE);
		}));
});

describe("live broker claim", () => {
	it("refuses to replace a live broker pid", () =>
		withTempDir((root) => {
			const pidPath = join(root, "broker.pid");
			writeFileSync(pidPath, `${process.pid}\n`);
			expect(() => assertNoLiveBroker(pidPath)).toThrow(`Refusing to replace live intercom broker process ${process.pid}`);
		}));

	it("tolerates absent, invalid and stale pid files", () =>
		withTempDir((root) => {
			const pidPath = join(root, "broker.pid");
			expect(() => assertNoLiveBroker(pidPath)).not.toThrow();
			writeFileSync(pidPath, "invalid\n");
			expect(() => assertNoLiveBroker(pidPath)).not.toThrow();
			writeFileSync(pidPath, "2147483647\n");
			expect(() => assertNoLiveBroker(pidPath)).not.toThrow();
		}));
});

describe("same cwd", () => {
	it("matches lexical variants and symlinks of one directory", () =>
		withTempDir((root) => {
			const real = join(root, "real");
			mkdirSync(real);
			symlinkSync(real, join(root, "link"));
			expect(sameCwd(real, `${real}/`)).toBe(true);
			expect(sameCwd(real, join(real, "sub", ".."))).toBe(true);
			expect(sameCwd(real, join(root, "link"))).toBe(true);
			expect(sameCwd(real, root)).toBe(false);
		}));

	it("falls back to the resolved path for a directory that no longer exists", () => {
		expect(sameCwd("/nonexistent/pi-intercom/a", "/nonexistent/pi-intercom/a/")).toBe(true);
	});
});
