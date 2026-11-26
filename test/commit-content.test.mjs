// node:test for the directory-aware parts of shared/commit-content.mjs: normalizeCommand (wrappers), resolveDir
// (what a directory argument resolves to), trackCommands / commitPlans (which repo each commit runs in). Real temp
// folders, so "does this directory exist" is real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitPlans, gitSub, normalizeCommand, resolveDir, shellWords, splitCommands, splitWithOps, trackCommands, words } from "../shared/commit-content.mjs";

/** root/{a, b, my dir, a/inner}, a fake home with proj/, and a file (not a directory). */
function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "commit-content-"));
	for (const d of ["a/inner", "b", "my dir", "home/proj"]) mkdirSync(path.join(root, d), { recursive: true });
	writeFileSync(path.join(root, "file.txt"), "x\n");
	const home = path.join(root, "home");
	return { root, home, opts: { cwd: root, home, env: { CLAUDE_PROJECT_DIR: path.join(root, "b") } }, at: (...p) => path.join(root, ...p) };
}
const only = (plans) => {
	assert.equal(plans.length, 1, JSON.stringify(plans));
	return plans[0];
};

test("normalizeCommand: wrappers are removed, in any order and nested", () => {
	const cases = {
		"git commit -m x": "git",
		"FOO=1 git commit -m x": "git",
		"env git commit": "git",
		"env FOO=1 git commit": "git",
		"env -i git commit": "git",
		"env -u FOO git commit": "git",
		"env --unset=FOO BAR=2 git commit": "git",
		"env -- git commit": "git",
		"command git commit": "git",
		"command -p git commit": "git",
		"\\git commit": "git",
		"/usr/bin/git commit": "git",
		"sudo git commit": "git",
		"sudo -u someone git commit": "git",
		"sudo --user=someone git commit": "git",
		"sudo -uroot git commit": "git",
		"sudo -E -H -n git commit": "git",
		"sudo -- git commit": "git",
		"sudo env git commit": "git",
		"env sudo -u x command /usr/bin/git commit": "git",
		"sudo -u someone rm -rf /": "rm",
		"sudo -g wheel -h host /bin/rm -rf /": "rm"
	};
	for (const [cmd, name] of Object.entries(cases)) {
		const n = normalizeCommand(cmd);
		assert.equal(n.words[0], name, cmd);
		assert.equal(n.words[1], name === "git" ? "commit" : "-rf", cmd);
	}
	assert.deepEqual(normalizeCommand("command -v git").words, [], "command -v only looks it up");
});

test("normalizeCommand: combined short flags follow getopt (a value-taking letter takes the rest, or the next word)", () => {
	assert.deepEqual(normalizeCommand("sudo -nu root git commit").words.slice(0, 2), ["git", "commit"]);
	assert.deepEqual(normalizeCommand("sudo -uroot git commit").words.slice(0, 2), ["git", "commit"]);
	assert.deepEqual(normalizeCommand("sudo -nD /tmp/x git commit").chdirs, ["/tmp/x"]);
	assert.deepEqual(normalizeCommand("sudo -nD/tmp/x git commit").chdirs, ["/tmp/x"]);
	assert.deepEqual(normalizeCommand("sudo -Eiu root -g wheel git commit").words.slice(0, 2), ["git", "commit"]);
	assert.deepEqual(normalizeCommand("env -iC /tmp/x git commit").chdirs, ["/tmp/x"]);
	assert.deepEqual(normalizeCommand("env -iu FOO git commit").words.slice(0, 2), ["git", "commit"]);
	assert.equal(normalizeCommand('env -iS "git commit"').split, "git commit");
	assert.equal(normalizeCommand("env - git commit").words[0], "git");
});

test("normalizeCommand: env -C / sudo -D directories, env -S strings, GIT_DIR / GIT_WORK_TREE", () => {
	assert.deepEqual(normalizeCommand("env -C /x git commit").chdirs, ["/x"]);
	assert.deepEqual(normalizeCommand("env --chdir=/x git commit").chdirs, ["/x"]);
	assert.deepEqual(normalizeCommand("env --chdir /x git commit").chdirs, ["/x"]);
	assert.deepEqual(normalizeCommand("sudo -D /x git commit").chdirs, ["/x"]);
	assert.deepEqual(normalizeCommand("sudo --chdir=/x env -C y git commit").chdirs, ["/x", "y"]);
	assert.equal(normalizeCommand('env -S "git commit -am x"').split, "git commit -am x");
	assert.equal(normalizeCommand('env --split-string="git commit"').split, "git commit");
	assert.equal(normalizeCommand("git commit").split, null);
	assert.equal(normalizeCommand("GIT_DIR=/x git commit").gitRepoVar, "GIT_DIR");
	assert.equal(normalizeCommand("env GIT_WORK_TREE=/x git commit").gitRepoVar, "GIT_WORK_TREE");
	assert.equal(normalizeCommand("FOO=1 git commit").gitRepoVar, null);
});

test("resolveDir: what resolves", () => {
	const f = fixture();
	const o = { home: f.home, env: { CLAUDE_PROJECT_DIR: f.at("b") } };
	assert.deepEqual(resolveDir(undefined, f.root, o), { dir: f.home }, "bare cd → home");
	assert.deepEqual(resolveDir("~", f.root, o), { dir: f.home });
	assert.deepEqual(resolveDir("~/proj", f.root, o), { dir: path.join(f.home, "proj") });
	assert.deepEqual(resolveDir("$HOME/proj", f.root, o), { dir: path.join(f.home, "proj") });
	assert.deepEqual(resolveDir("${HOME}", f.root, o), { dir: f.home });
	assert.deepEqual(resolveDir("$CLAUDE_PROJECT_DIR", f.root, o), { dir: f.at("b") });
	assert.deepEqual(resolveDir("a/inner", f.root, o), { dir: f.at("a", "inner") });
	assert.deepEqual(resolveDir("../b", f.at("a"), o), { dir: f.at("b") });
	assert.deepEqual(resolveDir(f.at("a"), null, o), { dir: f.at("a") }, "an absolute path resolves even from an unknown directory");
});

test("resolveDir: what doesn't, with the reason", () => {
	const f = fixture();
	const o = { home: f.home, env: {} };
	const cases = [
		["-", /cd -/],
		["~other", /another user's home/],
		["$DIR", /variable or command substitution/],
		["${DIR}/x", /variable or command substitution/],
		["$(git rev-parse --show-toplevel)", /variable or command substitution/],
		["`pwd`", /variable or command substitution/],
		["a*", /glob/],
		["missing", /doesn't exist/],
		["file.txt", /not a directory/],
		["$CLAUDE_PROJECT_DIR", /isn't set/],
		["$HOMEDIR", /variable or command substitution/]
	];
	for (const [arg, why] of cases) {
		const r = resolveDir(arg, f.root, o);
		assert.equal(r.dir, undefined, arg);
		assert.match(r.unresolved, why, arg);
	}
	assert.match(resolveDir("a", null, o).unresolved, /relative to a directory that isn't known/);
});

test("splitWithOps keeps the operator after each part", () => {
	assert.equal(splitWithOps("cd $(a && b) && git commit").length, 2, "no split inside $( … )");
	assert.deepEqual(splitWithOps('cd a && git commit -m "x | y" | cat; ls'), [
		{ text: "cd a", op: "&&" },
		{ text: 'git commit -m "x | y"', op: "|" },
		{ text: "cat", op: ";" },
		{ text: "ls", op: null }
	]);
});

test("commitPlans: resolvable forms commit in the right directory", () => {
	const f = fixture();
	const cases = [
		["git commit -m x", f.root],
		[`cd ${f.at("a")} && git commit -am x`, f.at("a")],
		["cd a && git commit -am x", f.at("a")],
		["cd a && cd ../b && git commit -am x", f.at("b")],
		["cd a; git commit -am x", f.at("a")],
		["cd && git commit -am x", f.home],
		["cd ~ && git commit -am x", f.home],
		["cd ~/proj && git commit -am x", path.join(f.home, "proj")],
		['cd "my dir" && git commit -am x', f.at("my dir")],
		["cd 'my dir' && git commit -am x", f.at("my dir")],
		["cd -P a && git commit -am x", f.at("a")],
		["cd $CLAUDE_PROJECT_DIR && git commit -am x", f.at("b")],
		["pushd a && git commit -am x", f.at("a")],
		["pushd -n a && git commit -am x", f.root],
		["env -C a git commit -am x", f.at("a")],
		["env --chdir=a git commit -am x", f.at("a")],
		["sudo -D a git commit -am x", f.at("a")],
		["git -C a commit -am x", f.at("a")],
		["git -C a -C inner commit -am x", f.at("a", "inner")],
		["env -C a git -C ../b commit -am x", f.at("b")],
		["sudo -u someone env FOO=1 \\git -C b commit -am x", f.at("b")],
		["cd $DIR && cd a && git commit -am x", null], // relative after unknown stays unknown
		[`cd $DIR && cd ${f.at("a")} && git commit -am x`, f.at("a")], // an absolute cd recovers
		["cd a | git commit -m x", f.root], // a pipeline stage's cd doesn't carry over
		["( cd a && make ) && git commit -am x", f.root], // the subshell's cd ends at ")"
		["(cd a) && git commit -am x", f.root],
		["( cd a && ( cd inner ) ) && git commit -am x", f.root],
		["{ cd a; } && git commit -am x", f.at("a")], // a { … } group runs in the same shell
		["{ cd a; git commit -am x; }", f.at("a")],
		["{ ( cd b ); cd a; } && git commit -am x", f.at("a")],
		["sudo -nu root git commit -am x", f.root],
		["sudo -uroot git commit -am x", f.root],
		[`sudo -nD ${f.at("a")} git commit -am x`, f.at("a")],
		[`env -iC ${f.at("a")} git commit -am x`, f.at("a")],
		["sudo -nDa git commit -am x", f.at("a")] // -D's value is the rest of the cluster: "a"
	];
	for (const [line, dir] of cases) {
		const p = only(commitPlans(line, f.opts));
		assert.equal(p.dir, dir, line);
		if (dir !== null) assert.equal(p.unresolved, null, line);
	}
	assert.equal(only(commitPlans("env -C a git commit -m x && git commit -m y", f.opts).slice(1)).dir, f.root, "env -C applies to its own command only");
});

test("commitPlans: unresolvable forms → dir null with the reason (never a guess)", () => {
	const f = fixture();
	const cases = [
		["cd $DIR && git commit -am x", /variable or command substitution/],
		['cd "$(git rev-parse --show-toplevel)" && git commit -am x', /variable or command substitution/],
		["cd $(git rev-parse --show-toplevel) && git commit -am x", /variable or command substitution/],
		["cd `pwd` && git commit -am x", /variable or command substitution/],
		["cd - && git commit -am x", /cd -/],
		["cd missing && git commit -am x", /doesn't exist/],
		["cd a b && git commit -am x", /more than one argument/],
		["pushd +1 && git commit -am x", /directory stack/],
		["pushd -2 && git commit -am x", /directory stack/],
		["pushd && git commit -am x", /pushd with no directory/],
		["popd && git commit -am x", /popd/],
		["pushd missing && git commit -am x", /doesn't exist/],
		["pushd $DIR && git commit -am x", /variable or command substitution/],
		["env -C missing git commit -am x", /env -C \/ sudo -D missing \(doesn't exist\)/],
		["env -C $DIR git commit -am x", /env -C \/ sudo -D .*variable/],
		["sudo -D $DIR git commit -am x", /variable/],
		["git -C missing commit -am x", /git -C missing \(doesn't exist\)/],
		["git -C $DIR commit -am x", /git -C .*variable/],
		["git --git-dir=/x commit -am x", /git --git-dir .*another repository/],
		["git --work-tree /x commit -am x", /git --work-tree .*another repository/],
		["GIT_DIR=/x git commit -am x", /GIT_DIR=… .*another repository/],
		["( cd a && git commit -am x )", /cd inside a \( … \) subshell/],
		["(cd a && git commit -am x)", /cd inside a \( … \) subshell/],
		['{ cd "$X"; } && git commit -am x', /variable/],
		["cd ~other && git commit -am x", /another user's home/]
	];
	for (const [line, why] of cases) {
		const p = only(commitPlans(line, f.opts));
		assert.equal(p.dir, null, line);
		assert.match(p.unresolved, why, line);
	}
	assert.match(only(commitPlans("cd $(git rev-parse --show-toplevel) && git commit -am x", f.opts)).unresolved, /^\$\(git rev-parse --show-toplevel\) \(/, "the reason quotes the whole substitution");
	assert.equal(only(commitPlans("(git commit -am x)", f.opts)).dir, f.root, "a subshell without a cd keeps the directory");
});

test("shellWords: quotes inside words, escapes, substitutions kept whole", () => {
	assert.deepEqual(shellWords('env --split-string="git commit -am x"'), ["env", "--split-string=git commit -am x"]);
	assert.deepEqual(shellWords("cd $(git rev-parse --show-toplevel) && x"), ["cd", "$(git rev-parse --show-toplevel)", "&&", "x"]);
	assert.deepEqual(shellWords('cd "$(git rev-parse --show-toplevel)"'), ["cd", "$(git rev-parse --show-toplevel)"]);
	assert.deepEqual(shellWords("\\git commit"), ["git", "commit"]);
	assert.deepEqual(shellWords("cd `pwd`"), ["cd", "`pwd`"]);
	assert.deepEqual(shellWords("x 'a b'c \"d \\\" e\""), ["x", "a bc", 'd " e']);
});

test("commitPlans: env -S mentioning git → unparsable; without git → nothing", () => {
	const f = fixture();
	assert.deepEqual(commitPlans('env -S "git commit -am x"', f.opts), [{ unparsable: "env -S" }]);
	assert.deepEqual(commitPlans('env --split-string="git commit -am x"', f.opts), [{ unparsable: "env -S" }]);
	assert.deepEqual(commitPlans('sudo env -S "git commit -am x"', f.opts), [{ unparsable: "env -S" }]);
	assert.deepEqual(commitPlans('env -iS "git commit -am x"', f.opts), [{ unparsable: "env -S" }], "-S inside a cluster");
	assert.deepEqual(commitPlans('env -iS"git commit -am x"', f.opts), [{ unparsable: "env -S" }], "the rest of the cluster is the value");
	assert.deepEqual(commitPlans('env -S "echo hi"', f.opts), []);
});

test("commitPlans: every commit in the line; git add counts only toward a commit in the same directory", () => {
	const f = fixture();
	const two = commitPlans("git commit -m a && cd b && git commit -am b", f.opts);
	assert.deepEqual(two.map((p) => [p.dir, p.all]), [[f.root, false], [f.at("b"), true]]);
	assert.equal(only(commitPlans("git add . && git commit -m x", f.opts)).addAll, true);
	assert.equal(only(commitPlans("git add . && cd b && git commit -m x", f.opts)).addAll, false, "the add ran in another directory");
	assert.deepEqual(only(commitPlans("cd b && git add x.txt y.txt && git commit -m x", f.opts)).addPaths, ["x.txt", "y.txt"]);
	assert.equal(only(commitPlans("git add -u && git commit -m x", f.opts)).addTracked, true);
	assert.equal(only(commitPlans("git commit --all -m x", f.opts)).all, true);
	assert.equal(only(commitPlans("git commit -m 'add all'", f.opts)).all, false);
	assert.deepEqual(commitPlans("git status && command -v git", f.opts), []);
	const [first, second] = commitPlans("git add . && git commit -m a && git commit -m b", f.opts);
	assert.equal(first.addAll, true);
	assert.equal(second.addAll, false, "the add was used by the first commit");
});

test("trackCommands reports each command's directory", () => {
	const f = fixture();
	const t = trackCommands("cd a && ls && cd $X && ls", f.opts);
	assert.deepEqual(t.map((s) => [s.words[0], s.dir]), [["cd", f.root], ["ls", f.at("a")], ["cd", f.at("a")], ["ls", null]]);
	assert.match(t[3].why, /variable/);
});

test("the older exports that stay (gitSub, words, splitCommands) are unchanged; commitPlan is gone", async () => {
	assert.deepEqual(gitSub("git -C x commit -m y"), { sub: "commit", args: ["-m", "y"] });
	assert.equal(gitSub("env git commit"), null);
	assert.deepEqual(words(`a "b c" 'd'`), ["a", "b c", "d"]);
	assert.deepEqual(splitCommands("a && b | c; d"), ["a", "b", "c", "d"]);
	assert.equal((await import("../shared/commit-content.mjs")).commitPlan, undefined, "replaced by commitPlans");
});
