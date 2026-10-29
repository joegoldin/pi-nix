import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
assert(root, "usage: program-status <node_modules or workspace/packages> [source]");
const source = process.argv[3] === "source";
const load = (pkg, file) => import(pathToFileURL(`${root}/${source ? pkg : `@earendil-works/pi-${pkg}`}/${source ? "src" : "dist"}/${file}.${source ? "ts" : "js"}`).href);
if (source) {
	// Native source must use the matching TUI, not an older installed SDK.
	const tui = await load("tui", "index");
	const { mock } = await import("bun:test");
	const { createRequire } = await import("node:module");
	mock.module(createRequire(`${root}/coding-agent/src/config.ts`).resolve("@earendil-works/pi-tui"), () => tui);
}
const protocol = await load("tui", "program-status");
const { ProcessTerminal } = await load("tui", "terminal");
const { ProgramStatusReporter } = await load("coding-agent", "modes/interactive/program-status-reporter");
const failures = [];
function check(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (error) { failures.push(error); console.error(`FAIL ${name}: ${error.message}`); } }
const reports = sequence => [...sequence.matchAll(/\x1b\]7501;([^\x1b\x07]*)[\x1b\x07]/g)].map(match => Object.fromEntries(match[1].split(":").map(pair => pair.split(/=(.*)/s).slice(0, 2))));
function capture(fn) {
	const write = process.stdout.write; let output = "";
	process.stdout.write = chunk => { output += chunk; return true; };
	try { fn(); } finally { process.stdout.write = write; }
	return reports(output);
}
function reporterFixture() {
	const values = [];
	const reporter = new ProgramStatusReporter(() => ({ setProgramStatus: status => values.push(status) }), () => "Session");
	const root = () => values.filter(status => !status.id).at(-1);
	return { reporter, values, root };
}
check("all report fields, Unicode bounds, and state-specific metadata", () => {
	const value = protocol.formatProgramStatus({ state: "blocked", id: "pi/jobs/job-1", app: "pi", kind: "permission", title: "界".repeat(100), message: "🙂".repeat(1000) + "\n", progress: 42 });
	const row = reports(value)[0];
	assert.equal(row.id, "pi/jobs/job-1"); assert.equal(row.progress, "42");
	assert.equal(Buffer.from(row.title, "base64").length, 192);
	assert.equal(Buffer.from(row.msg, "base64").length, 2048);
	assert(Buffer.byteLength(value) <= 4096);
	const idle = reports(protocol.formatProgramStatus({ state: "idle", kind: "auth", progress: 25 }))[0];
	assert.equal(idle.kind, undefined); assert.equal(idle.progress, undefined);
});
check("invalid ids never address root; invalid values cannot inject reports", () => {
	for (const id of ["", "/bad", "bad/", "a//b", "x".repeat(33), Array(9).fill("a").join("/"), "a:" , "a".repeat(32) + "/" + "b".repeat(32) + "/" + "c".repeat(32) + "/" + "d".repeat(32)]) {
		assert.equal(protocol.formatProgramStatus({ state: "working", id }), "");
	}
	assert.equal(protocol.formatProgramStatus({ state: "bogus:state=error" }), "");
	const row = reports(protocol.formatProgramStatus({ state: "blocked", kind: "auth:state=done", message: "hello\x1b\n\t\u0085world" }))[0];
	assert.equal(row.kind, undefined); assert(!/[\u0000-\u001f\u007f-\u009f]/.test(Buffer.from(row.msg, "base64").toString()));
	for (const progress of [-1, 101, 1.5, NaN, "50"]) assert.equal(reports(protocol.formatProgramStatus({ state: "working", progress }))[0].progress, undefined);
});
check("feature reply parsing respects advertised sets and legacy defaults", () => {
	assert.deepEqual(protocol.parseProgramStatusReply?.("\x1b]7501;?\x07"), { states: ["idle", "working", "done", "blocked", "error"], kinds: ["permission", "question", "auth"] });
	assert.deepEqual(protocol.parseProgramStatusReply?.("\x1b]7501;?:states=working,idle:future=yes:kinds=auth:states=working,error\x1b\\"), { states: ["working", "error"], kinds: ["auth"] });
	assert.equal(protocol.parseProgramStatusReply?.("\x1b]7501;state=working\x07"), undefined);
});
check("terminal retains simultaneous records, replaces metadata, and clears only descendants", () => {
	const terminal = new ProcessTerminal();
	terminal.setProgramStatus({ state: "idle", app: "pi" });
	terminal.setProgramStatus({ state: "working", id: "pi/a", title: "old", progress: 20 });
	terminal.setProgramStatus({ state: "blocked", id: "pi/a/child", kind: "auth" });
	terminal.setProgramStatus({ state: "working", id: "pi/ab" });
	terminal.setProgramStatus({ state: "done", id: "pi/a" });
	terminal.setProgramStatus({ state: "clear", id: "pi/a" });
	terminal.programStatusSupported = true;
	const output = capture(() => terminal.writeProgramStatus());
	assert.deepEqual(output.map(row => row.id ?? "root"), ["root", "pi/ab"]);
	capture(() => terminal.setProgramStatus({ state: "clear" }));
	assert.deepEqual(capture(() => terminal.writeProgramStatus()), []);
});
check("negotiated capabilities reach the transport without leaking terminal replies to input", () => {
	const terminal = new ProcessTerminal();
	const on = process.stdin.on, override = process.env.PI_PROGRAM_STATUS;
	let receive; const input = [];
	delete process.env.PI_PROGRAM_STATUS;
	process.stdin.on = (event, listener) => { if (event === "data") receive = listener; return process.stdin; };
	terminal.inputHandler = data => input.push(data);
	try {
		terminal.setProgramStatus({ state: "blocked", kind: "permission", id: "pi/ask" });
		capture(() => terminal.queryAndEnableKittyProtocol());
		const output = capture(() => { receive("\x1b]7501;?:states=idle,blocked:"); receive("kinds=auth\x1b\\"); receive("\x1b[?62;4;52c"); });
		assert.equal(output[0].state, "blocked"); assert.equal(output[0].kind, undefined); assert.deepEqual(input, []);
	} finally {
		capture(() => terminal.stop()); process.stdin.on = on;
		if (override === undefined) delete process.env.PI_PROGRAM_STATUS; else process.env.PI_PROGRAM_STATUS = override;
	}
});
check("terminal stop preserves done/error and retires active states without global clear", () => {
	const terminal = new ProcessTerminal();
	terminal.setProgramStatus({ state: "done", app: "pi" });
	terminal.setProgramStatus({ state: "error", id: "pi/failed" });
	terminal.setProgramStatus({ state: "working", id: "pi/running" });
	terminal.programStatusSupported = true;
	const output = capture(() => terminal.stop());
	assert(!output.some(row => row.state === "clear" || (!row.id && row.state === "idle")));
	assert(output.some(row => row.id === "pi/running" && row.state === "idle"));
	terminal.programStatusSupported = true;
	const replay = capture(() => terminal.writeProgramStatus());
	assert(replay.some(row => row.id === "pi/failed" && row.state === "error"));
	assert(replay.some(row => row.id === "pi/running" && row.state === "working"));
});
check("goal background waits keep root working after the model settles; user waits block", () => {
	const { reporter, root, values } = reporterFixture();
	reporter.handleEvent({ type: "agent_start" });
	reporter.setActivity?.("goal", { state: "working", title: "Goal", message: "Waiting for background work" });
	reporter.handleEvent({ type: "agent_settled", aborted: false });
	assert.equal(root().state, "working");
	reporter.setActivity?.("goal", { state: "blocked", kind: "question", title: "Goal", message: "Waiting for you" });
	assert.equal(root().state, "blocked"); assert.equal(root().kind, "question");
	reporter.setBlocked("approval", { kind: "permission", message: "Approve action" }); assert.equal(root().kind, "permission");
	reporter.setBlocked("approval", undefined); assert.equal(root().kind, "question");
	reporter.setActivity?.("goal", undefined); assert.equal(root().state, "done");
	assert(values.some(value => value.id === "pi/goal" && value.state === "clear"));
});
check("reset retires owned activities and stale blockers without clearing unrelated records", () => {
	const { reporter, root, values } = reporterFixture();
	reporter.setBlocked("old-dialog", { kind: "question", message: "stale" });
	reporter.setActivity?.("jobs/one", { state: "working" });
	reporter.reset(); assert.equal(root().state, "idle");
	assert(values.some(value => value.id === "pi/jobs/one" && value.state === "clear"));
	assert(!values.some(value => !value.id && value.state === "clear"));
});
check("parent activity clearing removes descendants but not prefix siblings", () => {
	const { reporter, root } = reporterFixture();
	reporter.setActivity?.("jobs/one", { state: "blocked", kind: "auth" });
	reporter.setActivity?.("jobs-extra", { state: "working" });
	reporter.setActivity?.("jobs", undefined);
	assert.equal(root().state, "working");
	reporter.setActivity?.("jobs-extra", undefined); assert.equal(root().state, "idle");
});
check("terminal negotiates states/kinds and bounds record storage", () => {
	const terminal = new ProcessTerminal();
	terminal.programStatusSupported = true;
	terminal.programStatusCapabilities = { states: ["idle", "blocked"], kinds: ["auth"] };
	let output = capture(() => terminal.setProgramStatus({ state: "blocked", kind: "permission", id: "pi/ask", message: "Approval required" }));
	assert.equal(output[0].state, "blocked"); assert.equal(output[0].kind, undefined);
	output = capture(() => terminal.setProgramStatus({ state: "working", id: "pi/work" }));
	assert.equal(output[0].state, "idle");
	capture(() => { for (let i = 0; i < 300; i++) terminal.setProgramStatus({ state: "done", id: `pi/job-${i}` }); });
	assert.equal(capture(() => terminal.writeProgramStatus()).length, 256);
});
check("completed history cannot evict an unresolved user blocker", () => {
	const { reporter, root } = reporterFixture(); const terminal = new ProcessTerminal();
	reporter.setActivity("goal", { state: "blocked", kind: "question" });
	terminal.setProgramStatus({ id: "pi/goal", state: "blocked", kind: "question" });
	for (let i = 0; i < 300; i++) {
		reporter.setActivity(`jobs/${i}`, { state: "done" });
		terminal.setProgramStatus({ id: `pi/jobs/${i}`, state: "done" });
	}
	assert.equal(root().state, "blocked"); assert(terminal.programStatuses.has("pi/goal"));
});
check("owned prompt markers and full resets restore status, including split writes", () => {
	const terminal = new ProcessTerminal();
	terminal.setProgramStatus({ state: "working", app: "pi" });
	terminal.setProgramStatus({ state: "blocked", id: "pi/ask", kind: "question" });
	terminal.programStatusSupported = true;
	let output = capture(() => { terminal.write("\x1b]13"); terminal.write("3;A;pi=user\x1b"); terminal.write("\\text"); });
	assert(output.some(row => row.state === "working"));
	assert(output.some(row => row.id === "pi/ask" && row.state === "blocked"));
	assert.deepEqual(capture(() => terminal.write("ordinary output")), []);
	output = capture(() => terminal.write("\x1bc")); assert.equal(output.length, 2);
});
check("explicit worker cancellation returns an otherwise settled program to idle", () => {
	const { reporter, root } = reporterFixture();
	reporter.handleEvent({ type: "agent_start" }); reporter.handleEvent({ type: "agent_settled", aborted: false });
	reporter.setActivity("goal", { state: "working" });
	reporter.setActivity("goal", { state: "idle" }); assert.equal(root().state, "idle");
});
check("tool execution and retry waits stay working with non-sensitive phase messages", () => {
	const { reporter, root, values } = reporterFixture();
	reporter.handleEvent({ type: "agent_start" });
	reporter.handleEvent({ type: "tool_execution_start", toolCallId: "one", toolName: "bash", args: { command: "PRIVATE_ARGUMENT" } });
	assert.equal(root().message, "Running bash");
	reporter.handleEvent({ type: "tool_execution_end", toolCallId: "one", toolName: "bash", isError: true });
	assert.equal(root().state, "working");
	reporter.handleEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "PRIVATE_PROVIDER_ERROR" });
	assert.equal(root().state, "working"); assert.equal(root().message, "Waiting to retry request");
	reporter.handleEvent({ type: "auto_retry_end", success: false, attempt: 1 });
	reporter.handleEvent({ type: "agent_settled", aborted: true }); assert.equal(root().state, "idle");
	assert(!JSON.stringify(values).includes("PRIVATE_"));
});
const { InteractiveMode } = await load("coding-agent", "modes/interactive/interactive-mode");
check("read-only dialogs cannot hide pending approvals or retain closed ones", () => {
	const { reporter, root } = reporterFixture(); const approval = {};
	const host = { programStatus: reporter, editor: {}, extensionDialogs: [{ component: approval, blocked: { kind: "permission", message: "Approve" } }, { component: {} }], editorContainer: { clear() {}, addChild() {} }, ui: { setFocus() {}, requestRender() {} } };
	InteractiveMode.prototype.showTopExtensionDialog.call(host); assert.equal(root().state, "blocked");
	InteractiveMode.prototype.removeExtensionDialog.call(host, approval); assert.equal(root().state, "idle");
});
for (const outcome of ["done", "error", "idle"]) {
	try {
		const { reporter, root, values } = reporterFixture();
		const abort = new AbortController(); if (outcome === "idle") abort.abort();
		const host = { programStatus: reporter, settingsManager: {}, session: { modelRuntime: { login: async () => {
			assert.equal(root().kind, "auth");
			if (outcome !== "done") throw new Error(outcome === "idle" ? "Login cancelled" : "PRIVATE_CREDENTIAL_FAILURE");
		} } } };
		const pending = InteractiveMode.prototype.loginProvider.call(host, { signal: abort.signal }, "test", "Test", "oauth");
		if (outcome === "done") await pending; else await assert.rejects(pending);
		assert.equal(root().state, outcome);
		assert(!JSON.stringify(values).includes("PRIVATE_CREDENTIAL"));
		console.log(`PASS authentication ${outcome}`);
	} catch (error) { failures.push(error); console.error(`FAIL authentication ${outcome}: ${error.message}`); }
}
if (failures.length) throw new AggregateError(failures, `${failures.length} program-status checks failed`);
