import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	addressFor,
	claudeConfigDir,
	defaultSocketPath,
	derivedName,
	isEntryFileName,
	isProcStart,
	keyFileName,
	percentEncode,
	socketFromAddress,
	socketLabel,
} from "./paths.ts";

describe("claudeConfigDir", () => {
	it("defaults to ~/.claude", () => {
		expect(claudeConfigDir({}, "/home/u")).toBe("/home/u/.claude");
	});

	it("follows CLAUDE_CONFIG_DIR", () => {
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/srv/claude" }, "/home/u")).toBe("/srv/claude");
	});

	it("treats a blank CLAUDE_CONFIG_DIR as unset, as Claude does", () => {
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "  " }, "/home/u")).toBe("/home/u/.claude");
	});
});

describe("defaultSocketPath", () => {
	it("uses /tmp/cc-socks without XDG_RUNTIME_DIR", () => {
		expect(defaultSocketPath(42, 501, {})).toBe("/tmp/cc-socks/42.sock");
	});

	it("uses XDG_RUNTIME_DIR when set", () => {
		expect(defaultSocketPath(42, 1000, { XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/cc-socks/42.sock");
	});

	// Unix socket paths cap out near 104 bytes; past 103 Claude moves to a
	// short per-uid directory instead.
	it("falls back to /tmp/cc-socks-<uid> past 103 bytes", () => {
		const long = `/run/${"x".repeat(100)}`;
		expect(defaultSocketPath(42, 1000, { XDG_RUNTIME_DIR: long })).toBe("/tmp/cc-socks-1000/42.sock");
	});

	it("keeps a path of exactly 103 bytes", () => {
		const dir = `/${"d".repeat(103 - "/cc-socks/42.sock".length - 1)}`;
		const path = defaultSocketPath(42, 1, { XDG_RUNTIME_DIR: dir });
		expect(Buffer.byteLength(path)).toBe(103);
		expect(path.startsWith(dir)).toBe(true);
	});
});

describe("addresses", () => {
	it("leaves the safe set alone", () => {
		expect(addressFor("/tmp/cc-socks/123.sock")).toBe("uds:/tmp/cc-socks/123.sock");
	});

	it("percent-encodes everything else as UTF-8 bytes, upper case", () => {
		expect(percentEncode("/home/me/~ dir/é.sock")).toBe("/home/me/%7E%20dir/%C3%A9.sock");
		expect(percentEncode("a%b")).toBe("a%25b");
	});

	it("decodes back to the path", () => {
		const path = "/Users/a b/~/π/1.sock";
		expect(socketFromAddress(addressFor(path))).toBe(path);
	});

	it("rejects other schemes and empty addresses", () => {
		expect(socketFromAddress("bridge:/x")).toBeUndefined();
		expect(socketFromAddress("uds:")).toBeUndefined();
	});

	it("keeps a malformed escape rather than throwing", () => {
		expect(socketFromAddress("uds:/tmp/%E0.sock")).toBe("/tmp/%E0.sock");
	});

	it("labels a socket by its basename", () => {
		expect(socketLabel("/tmp/cc-socks/123.sock")).toBe("123");
	});
});

describe("keyFileName", () => {
	it("hashes the resolved socket path", () => {
		const hash = createHash("sha256").update("/tmp/cc-socks/7.sock").digest("hex");
		expect(keyFileName(7, "/tmp/cc-socks/../cc-socks/7.sock")).toBe(`7.${hash}.key`);
	});
});

describe("isEntryFileName", () => {
	it("accepts only <digits>.json", () => {
		expect(isEntryFileName("123.json")).toBe(true);
		for (const n of ["123.json.tmp.ab", "x.json", "123.abc.key", ".123.json", "123.JSON", "12a.json"]) {
			expect(isEntryFileName(n)).toBe(false);
		}
	});
});

describe("isProcStart", () => {
	it("matches ps lstart in the C locale", () => {
		expect(isProcStart("Mon Oct  5 05:53:57 2026")).toBe(true);
		expect(isProcStart("Tue Oct 13 02:29:52 2026")).toBe(true);
	});

	it("rejects other locales and formats", () => {
		expect(isProcStart("lun.  5 oct. 05:53:57 2026")).toBe(false);
		expect(isProcStart("2026-10-05T05:53:57Z")).toBe(false);
		expect(isProcStart("Mon Oct  5 05:53:57 2026   ")).toBe(false);
	});
});

describe("derivedName", () => {
	it("is pi-<dir> with unsafe characters replaced", () => {
		expect(derivedName("/Users/joe/Development/my repo!")).toBe("pi-my-repo-");
	});

	it("caps the slug at 32 characters", () => {
		expect(derivedName(`/x/${"a".repeat(40)}`)).toBe(`pi-${"a".repeat(32)}`);
	});

	it("has a name for the root directory", () => {
		expect(derivedName("/")).toBe("pi-session");
	});
});
