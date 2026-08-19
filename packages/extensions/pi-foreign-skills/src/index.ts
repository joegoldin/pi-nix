import { discoverForeignSkillDirs } from "./discover.ts";

export interface ForeignSkillsHost {
	on(event: string, handler: (event: never, ctx?: never) => unknown): void;
}

export function registerHandlers(pi: ForeignSkillsHost, discover = discoverForeignSkillDirs): void {
	pi.on("resources_discover", (event: never) => {
		const e = event as unknown as { cwd?: string };
		if (typeof e.cwd !== "string" || e.cwd === "") return {};
		return { skillPaths: discover(e.cwd) };
	});
}

export default function (pi: ForeignSkillsHost) {
	registerHandlers(pi);
}
