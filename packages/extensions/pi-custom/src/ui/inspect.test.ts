import { describe, expect, it } from "bun:test";
import { isInspection, splitCommand } from "./inspect.ts";

const reads = (command: string) => expect(isInspection(command)).toBe(true);
const acts = (command: string) => expect(isInspection(command)).toBe(false);

describe("splitCommand", () => {
	it("splits on every separator and removes quotes", () => {
		expect(splitCommand(`ls -la; cat 'a b' && rg "x y" | head -n 3 || echo no\nwc -l a & pwd`)).toEqual([
			["ls", "-la"],
			["cat", "a b"],
			["rg", "x y"],
			["head", "-n", "3"],
			["echo", "no"],
			["wc", "-l", "a"],
			["pwd"],
		]);
	});

	it("keeps separators and escapes inside quotes as text", () => {
		expect(splitCommand(`echo "a;b|c" 'd&&e' f\\;g`)).toEqual([["echo", "a;b|c", "d&&e", "f;g"]]);
	});

	it("drops comments and joins continued lines", () => {
		expect(splitCommand("ls \\\n  -la # list it\n")).toEqual([["ls", "-la"]]);
	});

	it("refuses command substitution, subshells and unclosed quotes", () => {
		expect(splitCommand("echo $(rm -rf x)")).toBeUndefined();
		expect(splitCommand('echo "$(whoami)"')).toBeUndefined();
		expect(splitCommand("echo `id`")).toBeUndefined();
		expect(splitCommand("(cd x; ls)")).toBeUndefined();
		expect(splitCommand("diff <(ls a) <(ls b)")).toBeUndefined();
		expect(splitCommand("echo 'open")).toBeUndefined();
	});

	it("reads $(…) in single quotes as text", () => {
		expect(splitCommand("echo '$(x)'")).toEqual([["echo", "$(x)"]]);
	});
});

describe("isInspection", () => {
	it("folds plain inspection commands", () => {
		for (const command of [
			"ls",
			"cat README.md",
			"head -n 20 a.ts",
			"tail -f log",
			"wc -l src/*.ts",
			"file x",
			"stat x",
			"du -sh .",
			"df -h",
			"tree src",
			"pwd",
			"which bun",
			"type ls",
			'echo "hi"',
			"printf '%s\\n' a",
			"grep -rn foo src",
			"rg -n 'foo bar' src",
			"ag foo",
			"fd -e ts",
			"find . -name '*.ts' -type f",
			"jq .name package.json",
			"yq .a x.yaml",
			"sort a | uniq -c | sort -rn",
			"cut -d: -f1 /etc/passwd | tr a-z A-Z | column -t",
			"diff a b",
			"cmp a b",
			"ps aux",
			"env",
			"date +%s",
			"uname -a",
			"less x",
		]) {
			reads(command);
		}
	});

	it("folds a chain only when every program in it inspects", () => {
		reads("ls -la && cat a.ts | head -5; rg foo");
		acts("ls && rm a");
		acts("cat a | tee b");
		acts("rg foo | xargs sed -i s/a/b/");
	});

	it("treats unknown programs and the usual writers as doing something", () => {
		for (const command of ["rm -rf x", "mv a b", "cp a b", "mkdir -p x", "sudo ls", "tee x", "make", "./script.sh", "/bin/ls", "$EDITOR x", "npm test", "python3 x.py"]) {
			acts(command);
		}
	});

	it("allows leading assignments and a cd prefix", () => {
		reads("FOO=bar ls");
		reads("LC_ALL=C GIT_PAGER=cat git log -3");
		reads("cd src && ls");
		reads("cd /tmp/x; rg foo");
		reads("FOO=1");
		acts("FOO=bar make");
	});

	it("follows env into the program it runs", () => {
		reads("env FOO=1 ls");
		reads("env -i PATH=/bin cat x");
		acts("env FOO=1 rm x");
		acts("env -S 'rm x'");
	});

	it("allows redirections that write nowhere, and refuses those into a file", () => {
		reads("ls 2>/dev/null");
		reads("rg foo >/dev/null 2>&1");
		reads("cat x 2> /dev/null | head");
		reads("grep foo < input.txt");
		reads("ls &>/dev/null");
		reads("echo x >&2");
		acts("echo hi > x/f");
		acts("ls >> out.txt");
		acts("ls 2>err.log");
		acts("ls &> all.log");
		acts("ls >| out");
		acts("cat <> f");
		acts("echo >$FILE");
	});

	it("finds only without -delete or -exec", () => {
		reads("find . -name x -print");
		acts("find . -name '*.o' -delete");
		acts("find . -exec rm {} \\;");
		acts("find . -execdir ls \\;");
		acts("find . -ok rm {} \\;");
		acts("find . -fprint out");
	});

	it("allows fd, rg, sort, tree and uniq only without their writing or running options", () => {
		acts("fd -x rm");
		acts("fd -e o --exec rm");
		acts("rg --pre ./decode foo");
		acts("sort -o out a");
		acts("sort --output=out a");
		acts("tree -o out.txt");
		acts("uniq in out");
		reads("uniq -c in");
	});

	it("allows sed only with -n and without -i", () => {
		reads("sed -n '1,20p' a.ts");
		reads("sed -n -e 's/a/b/p' a.ts");
		reads("sed -En '/x/p' a.ts");
		reads("sed --quiet 5p a");
		acts("sed 's/a/b/' a.ts");
		acts("sed -n -i 's/a/b/' a.ts");
		acts("sed -ni 's/a/b/' a.ts");
		acts("sed -n -i.bak 1p a");
		acts("sed -n --in-place 1p a");
	});

	it("allows awk without redirection, pipes or system()", () => {
		reads("awk '{print $1}' a");
		acts("awk '{print > \"out\"}' a");
		acts("awk '{print | \"sh\"}' a");
		acts("awk 'BEGIN{system(\"rm x\")}'");
		acts("awk -i inplace '{print}' a");
	});

	it("allows yq without -i", () => {
		acts("yq -i '.a = 1' x.yaml");
		acts("yq --inplace .a x.yaml");
	});

	it("allows git's reading subcommands, around its global options", () => {
		for (const command of [
			"git status",
			"git log --oneline -5",
			"git diff HEAD~1",
			"git show HEAD:a.ts",
			"git blame a.ts",
			"git branch",
			"git branch -a --show-current",
			"git remote -v",
			"git remote show origin",
			"git remote get-url origin",
			"git rev-parse HEAD",
			"git ls-files",
			"git describe --tags",
			"git grep foo",
			"git -C sub --no-pager log",
			"git -c core.pager=cat diff",
		]) {
			reads(command);
		}
		for (const command of [
			"git commit -m x",
			"git push",
			"git checkout x",
			"git branch new",
			"git branch -D old",
			"git branch --delete old",
			"git remote add o url",
			"git remote remove o",
			"git diff --output=x.patch",
			"git -C sub reset --hard",
			"git",
		]) {
			acts(command);
		}
	});

	it("allows jj's reading subcommands", () => {
		for (const command of [
			"jj st",
			"jj status",
			"jj log -r 'all()'",
			"jj diff --git",
			"jj show @-",
			"jj op log",
			"jj operation log",
			"jj evolog",
			"jj bookmark list",
			"jj b l",
			"jj file show a.ts",
			"jj file list",
			"jj -R ../x --no-pager log",
		]) {
			reads(command);
		}
		for (const command of ["jj new", "jj describe -m x", "jj squash", "jj op restore x", "jj bookmark set x", "jj file chmod x a", "jj git push"]) {
			acts(command);
		}
	});

	it("allows nix's reading subcommands", () => {
		for (const command of [
			"nix eval .#x",
			"nix flake show",
			"nix flake metadata --json",
			"nix path-info -rS .#x",
			"nix why-depends a b",
			"nix log /nix/store/x.drv",
			"nix --extra-experimental-features 'nix-command flakes' eval --raw .#x",
			"nix --option substituters https://cache.nixos.org eval .#x",
		]) {
			reads(command);
		}
		for (const command of ["nix build .#x", "nix flake update", "nix run .#x", "nix eval --write-to out .#x", "nix store gc"]) {
			acts(command);
		}
	});

	it("allows gh's reading subcommands, and gh api only as a GET", () => {
		for (const command of [
			"gh pr view 12",
			"gh pr list --state open",
			"gh pr checks 12",
			"gh issue view 3",
			"gh issue list",
			"gh run view 99 --log",
			"gh run list",
			"gh api repos/o/r/pulls",
			"gh api -X GET repos/o/r",
			"gh api --method=get repos/o/r",
			"gh api --paginate repos/o/r/issues --jq '.[].title'",
		]) {
			reads(command);
		}
		for (const command of [
			"gh pr merge 12",
			"gh pr create",
			"gh issue close 3",
			"gh run rerun 9",
			"gh api -X POST repos/o/r/issues",
			"gh api -XDELETE repos/o/r",
			"gh api --method PATCH repos/o/r",
			"gh api repos/o/r/issues -f title=x",
			"gh api repos/o/r/issues -F n=1",
			"gh api repos/o/r/issues --field title=x",
			"gh api repos/o/r/issues --raw-field title=x",
			"gh api graphql --input q.json",
		]) {
			acts(command);
		}
	});

	it("allows kubectl, systemctl and journalctl only to read", () => {
		reads("kubectl get pods -A");
		reads("kubectl -n kube-system describe pod x");
		reads("kubectl --context prod logs x");
		acts("kubectl delete pod x");
		acts("kubectl apply -f x.yaml");
		reads("systemctl status nginx");
		reads("systemctl --user status x");
		acts("systemctl restart nginx");
		reads("journalctl -u nginx -n 50");
		acts("journalctl --vacuum-time=2d");
		acts("journalctl --rotate");
	});

	it("does not let date set the clock", () => {
		reads("date -u");
		acts("date -s '2020-01-01'");
		acts("date 0613162785");
	});

	it("allows `|| true` after a reader", () => {
		reads("grep foo a || true");
	});

	it("reads nothing into an empty command", () => {
		acts("");
		acts("   ");
		acts("# just a comment");
	});

	it("does not mistake a heredoc's body for commands that read", () => {
		acts("cat <<EOF > out\nhello\nEOF");
		acts("cat <<EOF\nhello\nEOF");
	});
});
