import { expect, test } from "bun:test";
import { coordinationKind } from "./coordination.ts";

test("the screenshot's literal todo cleanup is bookkeeping, not history deletion", () => {
	const code = `for(const id of [37,40,41]) text(await tools.todo({action:"delete",id}));
text(await tools.todo({action:"delete",id:30}));`;
	expect(coordinationKind("codemode", { code })).toBe("coordination");
	expect(coordinationKind("todo", { action: "delete", id: 37 })).toBe("coordination");
	expect(coordinationKind("codemode", { code: 'text(await tools.todo({action:"list"})); await tools.todo({id:30,action:"get"});' })).toBe("read-only");
	expect(coordinationKind("codemode", { code: "for (const id of [1,2]) { await tools.todo({id:id,action:'delete'}); }" })).toBe("coordination");
});

test("mixed, dynamic and unrecognized code never receives the bookkeeping shortcut", () => {
	for (const code of [
		'await tools.todo({action:"delete",id:30}); await tools.bash({command:"git push"});',
		'await tools.todo({action:"clear"});',
		'await tools.todo({action:"delete",id:load("id")});',
		'for(const id of load("ids")) await tools.todo({action:"delete",id});',
		'for(const id of [1]) { await tools.todo({action:"delete",id}); await tools.read({path:"secret"}); }',
		'await tools.todo({action:"delete",id:1,command:"rm -rf build"});',
		'await tools.todo({action:"delete",get id(){return 1}});',
		'tools.todo = tools.bash; await tools.todo({action:"delete",id:1});',
		'await tools.todo({action:"delete",id:1}); models.image("paid");',
		'await tools.todo({action:`delete`,id:1});',
		'await tools.todo({action:"delete",id:1,id:2});',
		'while(true) await tools.todo({action:"delete",id:1});',
		'for(const id of [1,...load("more")]) await tools.todo({action:"delete",id});',
	]) expect(coordinationKind("codemode", { code })).toBeUndefined();
	for (const input of [{ action: "clear" }, { action: "delete", id: "37" }, { action: "delete", id: 0 }, { action: "delete", id: 37, code: "extra" }])
		expect(coordinationKind("todo", input)).toBeUndefined();
});
