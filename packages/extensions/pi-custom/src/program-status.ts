import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ActivityStatus {
	state: "idle" | "working" | "blocked" | "done" | "error";
	kind?: "permission" | "question" | "auth";
	title?: string;
	message?: string;
	progress?: number;
}

/** Keep opaque/session ids within the protocol's 32-byte segment limit. */
export function activityKey(group: string, id: string): string {
	return `${group}/${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

/** Optional on older/RPC hosts; reporting must never change a tool's outcome. */
export function reportActivity(ctx: Pick<ExtensionContext, "ui" | "hasUI"> | undefined, key: string, status: ActivityStatus | undefined): void {
	if (!ctx || ctx.hasUI === false) return;
	try {
		(ctx.ui as { setProgramStatus?(key: string, status: ActivityStatus | undefined): void }).setProgramStatus?.(key, status);
	} catch {}
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Read the subagent provider's public projection on lifecycle changes, never poll or launch work. */
export function registerSubagentStatus(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: (() => void) | undefined;
	let dirty = false;
	let subscriptions: (() => void)[] = [];
	let reported = new Set<string>();
	const state = (value: unknown): ActivityStatus["state"] | undefined => {
		if (["running", "queued", "pending", "waiting"].includes(String(value))) return "working";
		if (value === "complete") return "done";
		if (["failed", "partial", "rejected"].includes(String(value))) return "error";
		if (["stopped", "paused"].includes(String(value))) return "idle";
	};
	const publish = (data: unknown) => {
		if (!record(data) || !record(data.fleet) || data.fleet.version !== 1 || !Number.isSafeInteger(data.fleet.totalActive) || (data.fleet.totalActive as number) < 0) return;
		const rows = new Map<string, ActivityStatus>();
		const visit = (value: unknown, parent: string, depth: number) => {
			if (depth > 3 || rows.size >= 128 || !record(value) || typeof value.id !== "string" || value.id.length > 512) return;
			const status = state(value.state); if (!status) return;
			const key = activityKey(parent, value.id);
			const title = value.kind === "workflow" ? "Workflow" : value.kind === "host-step" ? "Worker monitor" : "Subagent";
			rows.set(key, { state: status, title, message: `${title} ${value.state}` });
			if (Array.isArray(value.children)) for (const child of value.children.slice(0, 128)) visit(child, key, depth + 1);
		};
		const snapshot = data.asyncSnapshot;
		const runs = record(snapshot) && snapshot.version === 1 && snapshot.kind === "pi-subagents.async-status-snapshot" && Array.isArray(snapshot.runs) ? snapshot.runs.slice(0, 128) : [];
		for (const run of runs) visit(run, "subagents", 0);
		for (const key of reported) if (!rows.has(key)) reportActivity(ctx, key, undefined);
		for (const [key, status] of rows) reportActivity(ctx, key, status);
		reported = new Set(rows.keys());
		const latest = runs.filter(record).filter(run => state(run.state) !== "working").sort((a, b) => Number(b.endedAt ?? b.updatedAt ?? 0) - Number(a.endedAt ?? a.updatedAt ?? 0))[0];
		const active = data.fleet.totalActive as number;
		reportActivity(ctx, "subagents", { state: active > 0 ? "working" : state(latest?.state) ?? "idle", title: "Subagents", message: active > 0 ? `${active} subagent worker${active === 1 ? "" : "s"} active` : "Subagent workers settled" });
	};
	const schedule = () => {
		if (!ctx) return;
		if (pending) { dirty = true; return; }
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (!ctx) return;
			const current = generation, owner = ctx.sessionManager.getSessionId();
			const requestId = randomUUID();
			let off = () => {};
			const timeout = setTimeout(() => finish(), 2000);
			timeout.unref?.();
			const finish = () => {
				clearTimeout(timeout); off(); pending = undefined;
				if (dirty) { dirty = false; schedule(); }
			};
			pending = finish;
			off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, reply => {
				if (!record(reply) || reply.version !== 1 || reply.requestId !== requestId) return;
				if (current === generation && ctx?.sessionManager.getSessionId() === owner && reply.success === true) publish(reply.data);
				finish();
			});
			try { pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", source: { app: "pi-program-status" } }); }
			catch { finish(); }
		}, 50);
		timer.unref?.();
	};
	const dispose = () => {
		generation++; dirty = false;
		if (timer) clearTimeout(timer); timer = undefined;
		pending?.(); pending = undefined;
		for (const off of subscriptions) off(); subscriptions = [];
		reportActivity(ctx, "subagents", undefined); reported.clear(); ctx = undefined;
	};
	pi.on("session_start", (_event, context) => {
		dispose();
		if (!context.hasUI) return;
		ctx = context;
		for (const event of ["subagents:rpc:v1:ready", "subagent:jobs-changed", "subagent:async-started", "subagent:async-complete", "subagent:foreground-complete", "subagent:process-terminal", "subagent:child-status", "subagent:control-event"]) subscriptions.push(pi.events.on(event, schedule));
		schedule();
	});
	pi.on("session_shutdown", dispose);
}
