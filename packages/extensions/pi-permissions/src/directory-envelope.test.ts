import { expect, test } from "bun:test";
import { encloseInDelegationEnvelope } from "./engine/authority/delegation-envelope.ts";

test("native directory receipts cannot become model authority or override other checks", async () => {
	if (process.env.PI_DIRECTORY_ENVELOPE_CHILD !== "1") {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PI_DIRECTORY_ENVELOPE_CHILD: "1", PI_PERMISSION_DELEGATION_EXCLUDED_SURFACES: "external_directory,path" },
			stdout: "pipe", stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ code, output: code === 0 ? "passed" : stdout + stderr }).toEqual({ code: 0, output: "passed" });
		return;
	}
	const receipts = new WeakSet<object>();
	const request = { requestId: "request", accessIntent: { surface: "external_directory_write" } };
	const log = { review() {}, debug() {} };
	const authorize = encloseInDelegationEnvelope(async () => ({ kind: "allow" }), details => receipts.delete(details));
	const decide = (details: object) => authorize(details as never, {} as never, log);
	expect(await decide(request)).toEqual({ kind: "defer" });
	receipts.add(request);
	expect(await decide({ ...request, nativeDirectoryApproval: true })).toEqual({ kind: "defer" });
	expect(await decide(request)).toEqual({ kind: "allow" });
	expect(await decide(request)).toEqual({ kind: "defer" });
	for (const surface of ["path", "path_read", "path_write", undefined]) {
		const other = { accessIntent: { surface } };
		receipts.add(other);
		expect(await decide(other)).toEqual({ kind: "defer" });
	}
	const ordinary = encloseInDelegationEnvelope(async () => ({ kind: "allow" }), () => { throw new Error("A receipt only settles directory checks"); });
	for (const surface of ["bash", "external_directory_unknown"]) {
		expect(await ordinary({ accessIntent: { surface } } as never, {} as never, log)).toEqual({ kind: "allow" });
	}
	for (const kind of ["deny", "defer"] as const) {
		const refused = encloseInDelegationEnvelope(async () => ({ kind }), () => { throw new Error("A receipt must not override this verdict"); });
		expect(await refused(request as never, {} as never, log)).toEqual({ kind });
	}
});
