import { expect, test } from "bun:test";
import { validateDirectoryProposal } from "./directory-proposal.ts";

const candidates = [{ path: "/work/repo", access: "read" as const }];

test("model recommendations select native candidates and explicit capability combinations", () => {
	expect(validateDirectoryProposal({ directories: [{ candidate: 0, access: "write-execute" }] }, candidates))
		.toEqual([{ path: "/work/repo", access: "write-execute" }]);
});

test("model output cannot supply a broader path, unknown capability, duplicate, or missing target", () => {
	for (const directories of [
		[{ candidate: 1, access: "write" }],
		[{ candidate: 0, path: "/", access: "write" }],
		[{ candidate: 0, access: "all" }],
		[{ candidate: 0, access: "write" }, { candidate: 0, access: "read" }],
		[],
	]) expect(validateDirectoryProposal({ directories }, candidates)).toBeUndefined();
});

test("a write request cannot be presented as read-only approval", () => {
	expect(validateDirectoryProposal({ directories: [{ candidate: 0, access: "read" }] }, [{ path: "/work/repo", access: "write" }])).toBeUndefined();
});

test("the model can choose a narrower native folder but not a parent outside the project", () => {
	const choices = [{ path: "/work/repo", access: "write" as const, folders: ["/work/repo", "/work/repo/research"] }];
	expect(validateDirectoryProposal({ directories: [{ candidate: 0, folder: 1, access: "write-execute" }] }, choices))
		.toEqual([{ path: "/work/repo/research", access: "write-execute" }]);
	for (const folder of [-1, 2, 0.5, "/work", "0"])
		expect(validateDirectoryProposal({ directories: [{ candidate: 0, folder, access: "write" }] }, choices)).toBeUndefined();
});
