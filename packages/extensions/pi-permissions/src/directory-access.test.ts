import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coversDirectoryRequest, requestedDirectories, type DirectoryAccess } from "./directory-access.ts";
import { deriveApprovalPatterns } from "./engine/path/approval-pattern.ts";
import { posixPathFlavor } from "./engine/path/path-flavor.ts";

function details(path: string, access: string, directory = false) {
  return { sessionApproval: { grants: deriveApprovalPatterns(path, posixPathFlavor, directory).map(pattern => ({ surface: `external_directory_${access}`, pattern })) } };
}

test("file and directory gate suggestions name the worktree and retain read/write direction", () => {
  const root = mkdtempSync(join(tmpdir(), "directory-grants-"));
  try {
    const repo = join(root, "worktree");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "Tests"));
    expect(requestedDirectories(details(join(repo, "Tests/test.swift"), "read"), root)).toEqual([{ path: repo, access: "read" }]);
    expect(requestedDirectories(details(join(repo, "Tests/test.swift"), "write"), root)).toEqual([{ path: repo, access: "write" }]);
    expect(requestedDirectories(details(repo, "read", true), root)).toEqual([{ path: repo, access: "read" }]);
    const outside = join(root, "outside");
    mkdirSync(join(outside, ".git"), { recursive: true });
    symlinkSync(outside, join(repo, "link"));
    expect(requestedDirectories(details(join(repo, "link/file"), "read"), root)).toEqual([{ path: outside, access: "read" }]);
    expect(requestedDirectories(details("/file", "write"), root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a direct write proposes writable project access even before the directory gate", () => {
  const root = mkdtempSync(join(tmpdir(), "directory-proposal-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const path = join(repo, "research/new-script.ts");
    expect(requestedDirectories(undefined, root, { toolName: "write", input: { path, content: "test" } }))
      .toEqual([{ path: repo, access: "write" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const { PermissionLedger } = await import("./denials.ts");

test("classifier directory facts exclude wrong access directions, siblings and symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "directory-context-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    symlinkSync(root, join(repo, "escape"));
    const ledger = new PermissionLedger();
    ledger.approveDirectory({ path: repo, access: "read" });
    const context = (toolName: string, path: string) => ledger.directoryApprovals(undefined, { toolName, input: { path }, cwd: root });
    expect(context("read", join(repo, "new/file"))).toHaveLength(1);
    expect(context("write", join(repo, "new/file"))).toHaveLength(0);
    expect(context("read", `${repo}-other/file`)).toHaveLength(0);
    expect(context("read", join(repo, "escape/file"))).toHaveLength(0);
    ledger.approveDirectory({ path: repo, access: "write" });
    expect(context("edit", join(repo, "new/file"))).toHaveLength(1);
    expect(context("read", join(repo, "escape/file"))).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native receipts require the requested capability at the canonical gate boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "directory-receipts-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    symlinkSync(root, join(repo, "escape"));
    const request = (surface: string, path: string) => ({ accessIntent: { surface, boundaryValue: path, matchValues: ["relative-policy-alias", path] } });
    for (const access of ["read", "write", "execute", "read-execute", "write-execute"] as const) {
      const grants: DirectoryAccess[] = [{ path: repo, access }];
      expect(coversDirectoryRequest(request("external_directory_read", join(repo, "file")), grants)).toBe(access !== "execute");
      expect(coversDirectoryRequest(request("external_directory_write", join(repo, "file")), grants)).toBe(access === "write" || access === "write-execute");
      for (const path of [join(repo, "escape/file"), `${repo}-sibling/file`, "relative/file"]) {
        expect(coversDirectoryRequest(request("external_directory_read", path), grants)).toBe(false);
      }
      expect(coversDirectoryRequest(request("path_write", join(repo, "file")), grants)).toBe(false);
      expect(coversDirectoryRequest({ surface: "external_directory_read", path: join(repo, "file") }, grants)).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
