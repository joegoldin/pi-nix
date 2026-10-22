import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestedDirectories } from "./directory-access.ts";
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
