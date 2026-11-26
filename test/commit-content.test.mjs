// node:test for the directory-aware parts of shared/commit-content.mjs: normalizeCommand (wrappers), resolveDir
// (what a directory argument resolves to), trackCommands / commitPlans (which repo each commit runs in). Real temp
// folders, so "does this directory exist" is real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { capFragment, commitPlans, contentToCommit, gitSub, normalizeCommand, resolveDir, runGitDefault, ScanTimeout, scanBudget, shellWords, splitCommands, splitWithOps, trackCommands, words } from "../shared/commit-content.mjs";

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

test("normalizeCommand: runners and shell keywords are unwrapped, nested", () => {
	const forms = [
		"! git commit -m x", "if git commit -m x", "then git commit -m x", "else git commit -m x", "elif git commit -m x", "do git commit -m x", "while git commit -m x", "until git commit -m x", "{ git commit -m x",
		"time git commit -m x", "time -p git commit -m x",
		"nohup git commit -m x", "nohup -- git commit -m x",
		"exec git commit -m x", "exec -a NAME git commit -m x", "exec -cl git commit -m x",
		"timeout 5 git commit -m x", "timeout -s KILL -k 2 5s git commit -m x", "timeout --signal=TERM --kill-after=1 10 git commit -m x", "timeout --preserve-status -v 5 git commit -m x",
		"nice git commit -m x", "nice -n 10 git commit -m x", "nice -n10 git commit -m x", "nice -5 git commit -m x", "nice --adjustment=3 git commit -m x",
		"ionice -c 2 -n 7 git commit -m x", "ionice -c2 -n7 -t git commit -m x",
		"stdbuf -oL git commit -m x", "stdbuf -i 0 -o L -e 0 git commit -m x", "stdbuf --output=L git commit -m x",
		"chrt -f 10 git commit -m x", "chrt --batch 0 git commit -m x", "chrt -d -T 100 -P 200 0 git commit -m x",
		"taskset 0x3 git commit -m x", "taskset -c 0,1 git commit -m x", "taskset -a -c 0-3 git commit -m x",
		"setsid git commit -m x", "setsid -f -w git commit -m x",
		"nohup sudo env git commit -m x", "time nice -n 5 timeout 3 sudo -u x git commit -m x", "! nohup /usr/bin/git commit -m x", "if ! timeout 5 git commit -m x"
	];
	for (const f of forms) assert.deepEqual(normalizeCommand(f).words.slice(0, 2), ["git", "commit"], f);
});

test("commitPlans: commits behind runners and keywords are planned normally", () => {
	const f = fixture();
	for (const line of ["if true; then git commit -m x; fi", "! git commit -m x", "nohup git commit -m x", "timeout 5 git commit -m x", "while true; do git commit -m x; done", "nohup sudo env git commit -m x"]) {
		const p = only(commitPlans(line, f.opts));
		assert.equal(p.dir, f.root, line);
	}
	assert.equal(only(commitPlans(`timeout 5 git -C ${f.at("a")} commit -m x`, f.opts)).dir, f.at("a"));
});

test("commitPlans: an unrecognised command mentioning git … commit → unparsable; xargs running a commit → xargs", () => {
	const f = fixture();
	for (const line of ["parallel git commit ::: a", "watch git commit -m x"]) assert.deepEqual(commitPlans(line, f.opts), [{ unparsable: "commit" }], line);
	for (const line of ["xargs git commit", "xargs -0 git commit -m x", "xargs /usr/bin/git commit -m x", "xargs -n 1 -I {} git commit -m {}", "xargs --max-args=1 git commit", "xargs -P4 sudo git commit"]) {
		assert.deepEqual(commitPlans(line, f.opts), [{ unparsable: "xargs" }], line);
	}
	for (const line of ["xargs echo", "xargs git add", "xargs -0 rm -f", "xargs"]) assert.deepEqual(commitPlans(line, f.opts), [], line);
});

test("commitPlans: bash|sh|zsh|dash|ksh -c and eval strings are parsed as command lines (same directory)", () => {
	const f = fixture();
	const cases = [
		["bash -c 'git commit -am x'", f.root],
		['sh -c "cd a && git commit"', f.at("a")],
		["zsh -lc 'git commit -m x'", f.root],
		["dash -ec 'git commit -m x'", f.root],
		["bash -o pipefail -c 'git commit -m x'", f.root],
		["ksh -c 'git -C a commit'", f.at("a")],
		["eval git commit -m x", f.root],
		[`cd ${f.at("b")} && bash -c 'git commit -m x'`, f.at("b")]
	];
	for (const [line, dir] of cases) assert.equal(only(commitPlans(line, f.opts)).dir, dir, line);
	assert.match(only(commitPlans('cd "$X" && bash -c "git commit -m x"', f.opts)).unresolved, /variable/, "an unknown directory carries into the string");
	assert.deepEqual(commitPlans("bash -c 'echo hi'", f.opts), []);
});

test("commitPlans: quoted strings and other git commands don't trigger the catch-all", () => {
	const f = fixture();
	for (const line of ['echo "git commit"', "grep 'git commit' notes.txt", "git log --grep commit", "git help commit", "bash -c 'echo hi'", "bash -c 'git status'", "bash script.sh commit", "echo git", 'printf "%s" "git commit -m x"', "commit git"]) {
		assert.deepEqual(commitPlans(line, f.opts), [], line);
	}
	assert.equal(only(commitPlans("git commit -m x", f.opts)).dir, f.root, "a recognised commit is planned, not unparsable");
});

test("capFragment cuts the command fragment, keeps the explanation", () => {
	assert.equal(capFragment("short (why)"), "short (why)");
	assert.equal(capFragment(`${"x".repeat(80)} (why)`), `${"x".repeat(59)}… (why)`);
	assert.equal(capFragment("x".repeat(61)), `${"x".repeat(59)}…`);
	assert.equal(capFragment("cd inside a ( … ) subshell (commands after it there aren't tracked)"), "cd inside a ( … ) subshell (commands after it there aren't tracked)");
});

// ---- #31: git aliases and quoted eval ----

/** A repo with git aliases in its local config, and an isolated global config (a temp file) for the alias lookups. */
function aliasFixture({ local = {}, global = {} } = {}) {
	const f = fixture();
	spawnSync("git", ["init", "-q"], { cwd: f.root });
	for (const [k, v] of Object.entries(local)) spawnSync("git", ["config", `alias.${k}`, v], { cwd: f.root });
	const globalFile = path.join(f.root, ".test-global-gitconfig");
	writeFileSync(globalFile, Object.keys(global).length ? `[alias]\n${Object.entries(global).map(([k, v]) => `\t${k} = ${v}`).join("\n")}\n` : "");
	const env = { CLAUDE_PROJECT_DIR: f.at("b"), GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_NOSYSTEM: "1" };
	return { ...f, opts: { ...f.opts, env } };
}

/** A git runner that records calls and passes them to real git. */
function countingRunner() {
	const calls = [];
	const run = (args, o) => {
		calls.push(args);
		return runGitDefault(args, o);
	};
	return { run, calls };
}

test("aliases: git ci (alias.ci=commit) is a commit; -c alias inline; alias args come first; chains", () => {
	const f = aliasFixture({ local: { ci: "commit", cia: "commit -a", a: "b", b: "commit" } });
	assert.equal(only(commitPlans("git ci -m x", f.opts)).dir, f.root);
	assert.equal(only(commitPlans("git ci -m x", f.opts)).all, false);
	assert.equal(only(commitPlans("git cia -m x", f.opts)).all, true, "the alias's -a counts");
	assert.equal(only(commitPlans("git a -m x", f.opts)).dir, f.root, "alias → alias → commit");
	assert.equal(only(commitPlans("git -c alias.x=commit x -m y", f.opts)).dir, f.root, "inline -c alias");
	assert.equal(only(commitPlans("git -c alias.x='commit -a' x -m y", f.opts)).all, true);
});

test("aliases: system / global configs count (an alias only in GIT_CONFIG_GLOBAL resolves)", () => {
	const f = aliasFixture({ global: { gci: "commit" } });
	assert.equal(only(commitPlans("git gci -m x", f.opts)).dir, f.root);
});

test("aliases: an alias named like a real command is ignored, as git does (alias.status=commit + git status → no plan)", () => {
	const f = aliasFixture({ local: { status: "commit", l: "log" } });
	assert.deepEqual(commitPlans("git status", f.opts), []);
	assert.deepEqual(commitPlans("git l --oneline", f.opts), [], "an alias to log isn't a commit");
	assert.deepEqual(commitPlans("git nosuchalias", f.opts), [], "not an alias: git would just fail");
});

test("aliases: any shell alias that runs git, loops, --config-env → unparsable; a shell alias without git → nothing", () => {
	const f = aliasFixture({ local: { sc: "!sh -c 'git commit -m x'", fn: '!f() { git commit "$@"; }; f', x: '!f() { git "$@"; }; f', lg: "!git log --oneline | head", hi: "!echo hi", loop1: "loop2", loop2: "loop1" } });
	for (const line of ["git sc", "git fn -m x", "git x commit -m y", "git lg", "git loop1", "git --config-env=alias.z=SOME_VAR z"]) assert.deepEqual(commitPlans(line, f.opts), [{ unparsable: "commit" }], line);
	assert.deepEqual(commitPlans("git hi", f.opts), []);
});

test("aliases: resolved from the repo the command runs in; an alias in an unknown repo → unresolved", () => {
	const f = aliasFixture();
	spawnSync("git", ["init", "-q"], { cwd: f.at("b") });
	spawnSync("git", ["config", "alias.bci", "commit"], { cwd: f.at("b") });
	assert.deepEqual(commitPlans("git bci -m x", f.opts), [], "not an alias in the starting repo");
	assert.equal(only(commitPlans(`cd ${f.at("b")} && git bci -m x`, f.opts)).dir, f.at("b"), "the cd target's config");
	assert.equal(only(commitPlans(`git -C ${f.at("b")} bci -m x`, f.opts)).dir, f.at("b"));
	const p = only(commitPlans('cd "$X" && git bci -m x', f.opts));
	assert.equal(p.dir, null);
	assert.match(p.unresolved, /^git bci \(an alias in a repo that can't be determined\)$/);
	assert.match(only(commitPlans('cd "$X" && git commit -m x', f.opts)).unresolved, /variable/, "a commit in an unknown repo keeps its own reason");
	assert.deepEqual(commitPlans('cd "$X" && git status', f.opts), [], "a real command in an unknown repo: nothing");
});

test("aliases: -C inside an alias moves the repo", () => {
	const f = aliasFixture({ local: { cib: `-C ${"b"} commit` } });
	spawnSync("git", ["init", "-q"], { cwd: f.at("b") });
	assert.equal(only(commitPlans("git cib -m x", f.opts)).dir, f.at("b"));
});

test("aliases: a plain git commit makes no git calls; list-cmds runs once, only for an unknown subcommand", () => {
	const f = aliasFixture({ local: { ci: "commit" } });
	const plain = countingRunner();
	commitPlans("git add . && git commit -m x && git commit -am y", { ...f.opts, runGit: plain.run });
	assert.deepEqual(plain.calls, [], "commit and add need no lookups");
	const mixed = countingRunner();
	commitPlans("git status && git ci -m x && git log && git ci -m y", { ...f.opts, runGit: mixed.run });
	assert.equal(mixed.calls.filter((a) => a[0] === "--list-cmds=main,others").length, 1, "listed once per run");
	assert.equal(mixed.calls.filter((a) => a[0] === "config").length, 2, "one config lookup per alias use");
});

test("aliases: a timeout or an exhausted budget → unparsable (fake slow git)", () => {
	const f = aliasFixture({ local: { ci: "commit" } });
	// a git that times out on config
	const slowConfig = (args, o) => (args[0] === "config" ? { status: null, stdout: "", timedOut: true } : runGitDefault(args, o));
	assert.deepEqual(commitPlans("git ci -m x", { ...f.opts, runGit: slowConfig }), [{ unparsable: "commit" }]);
	// each call takes 2 s of fake time against the 5 s budget: list-cmds (2 s timeout) → config (2 s) → config with
	// only 1 s left (its timeout is cut to 1 s) → the third lookup has no time left
	let clock = 0;
	const timeouts = [];
	const timed = (args, o) => {
		timeouts.push(o.timeout);
		clock += 2000;
		return runGitDefault(args, o);
	};
	const plans = commitPlans("git ci -m a && git ci -m b && git ci -m c", { ...f.opts, runGit: timed, now: () => clock });
	assert.deepEqual(timeouts, [2000, 2000, 1000], "2 s per call, cut to what's left of the budget");
	assert.deepEqual(plans.map((p) => p.unparsable ?? p.dir), [f.root, f.root, "commit"], "within budget, then out of time");
});

test("aliases: a real slow git on PATH hits the 2 s timeout → unparsable", { skip: process.platform === "win32" }, () => {
	const f = aliasFixture();
	const bin = mkdtempSync(path.join(tmpdir(), "slow-git-"));
	writeFileSync(path.join(bin, "git"), '#!/bin/sh\ncase "$1" in --list-cmds=*) echo commit; echo status; exit 0;; esac\nsleep 4\n');
	chmodSync(path.join(bin, "git"), 0o755);
	const started = Date.now();
	const plans = commitPlans("git ci -m x", { ...f.opts, env: { ...f.opts.env, PATH: `${bin}:/usr/bin:/bin` } });
	const took = Date.now() - started;
	assert.deepEqual(plans, [{ unparsable: "commit" }]);
	assert.ok(took >= 1900 && took < 3900, `stopped at the 2 s timeout (took ${took} ms)`);
});

test("eval: a quoted eval string is parsed like a command line; other eval strings → nothing", () => {
	const f = fixture();
	assert.equal(only(commitPlans('eval "git commit -m x"', f.opts)).dir, f.root);
	assert.equal(only(commitPlans("eval 'git commit -m x'", f.opts)).dir, f.root);
	assert.equal(only(commitPlans('eval "cd a && git commit"', f.opts)).dir, f.at("a"));
	assert.deepEqual(commitPlans('eval "echo hi"', f.opts), []);
	assert.deepEqual(commitPlans('eval "git status"', f.opts), []);
});

test("aliases inside strings and xargs: bash -c / eval resolve aliases; xargs running an alias commit asks; nesting > 3 asks", () => {
	const f = aliasFixture({ local: { ci: "commit", l: "log" } });
	for (const line of ['bash -c "git ci -m x"', 'eval "git ci -m x"', "sh -c 'git commit -m x'", "bash -c \"bash -c 'bash -c \\\"git ci\\\"'\""]) {
		assert.equal(only(commitPlans(line, f.opts)).dir, f.root, line);
	}
	assert.deepEqual(commitPlans("xargs git ci", f.opts), [{ unparsable: "xargs" }]);
	assert.deepEqual(commitPlans("xargs -0 bash -c 'git ci -m x'", f.opts), [{ unparsable: "xargs" }], "xargs running a shell string with a commit");
	assert.deepEqual(commitPlans("xargs git l", f.opts), [], "an alias to log isn't a commit");
	assert.deepEqual(commitPlans(`bash -c "bash -c \\"bash -c 'bash -c git ci'\\""`, f.opts), [{ unparsable: "commit" }], "4 levels deep → ask");
	assert.deepEqual(commitPlans(`bash -c "bash -c \\"bash -c 'bash -c echo'\\""`, f.opts), [], "too deep, but no git in it");
	assert.deepEqual(commitPlans('bash -c "echo hi"', f.opts), []);
});

test("aliases: the command's own GIT_CONFIG_* / HOME prefixes count; a $ in them → unparsable", () => {
	const f = aliasFixture();
	const cfg = path.join(f.root, "extra.gitconfig");
	writeFileSync(cfg, "[alias]\n\tci = commit\n");
	assert.deepEqual(commitPlans("git ci -m x", f.opts), [], "no alias without the prefix");
	assert.equal(only(commitPlans(`GIT_CONFIG_GLOBAL=${cfg} git ci -m x`, f.opts)).dir, f.root);
	assert.equal(only(commitPlans("GIT_CONFIG_GLOBAL=extra.gitconfig git ci -m x", f.opts)).dir, f.root, "a relative path is relative to the command's directory");
	assert.equal(only(commitPlans(`env GIT_CONFIG_GLOBAL=${cfg} git ci -m x`, f.opts)).dir, f.root);
	assert.equal(only(commitPlans("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=commit git ci -m x", f.opts)).dir, f.root);
	assert.deepEqual(commitPlans("GIT_CONFIG_GLOBAL=$X git ci", f.opts), [{ unparsable: "commit" }]);
	assert.deepEqual(commitPlans('GIT_CONFIG_GLOBAL="$(mktemp)" git ci', f.opts), [{ unparsable: "commit" }]);
	assert.equal(only(commitPlans("GIT_CONFIG_GLOBAL=$X git commit -m x", f.opts)).dir, f.root, "no alias lookup needed for commit itself");
	assert.deepEqual(commitPlans(`GIT_CONFIG_GLOBAL=${cfg} git status`, f.opts), [], "a real command is never an alias");
});

test("aliases: outer env prefixes reach bash -c / eval strings; inner prefixes override", () => {
	const f = aliasFixture();
	const cfg = path.join(f.root, "extra.gitconfig");
	writeFileSync(cfg, "[alias]\n\tci = commit\n");
	const none = path.join(f.root, "none.gitconfig");
	writeFileSync(none, "");
	assert.equal(only(commitPlans(`GIT_CONFIG_GLOBAL=${cfg} bash -c 'git ci -m x'`, f.opts)).dir, f.root);
	assert.equal(only(commitPlans(`GIT_CONFIG_GLOBAL=${cfg} eval "git ci -m x"`, f.opts)).dir, f.root);
	assert.deepEqual(commitPlans(`GIT_CONFIG_GLOBAL=${cfg} bash -c 'GIT_CONFIG_GLOBAL=${none} git ci -m x'`, f.opts), [], "the inner prefix wins");
	assert.deepEqual(commitPlans(`GIT_CONFIG_GLOBAL=$X bash -c 'git ci -m x'`, f.opts), [{ unparsable: "commit" }]);
});

test("aliases: export / unset of git config variables carry across commands, like cd (subshells and pipelines don't)", () => {
	const f = aliasFixture();
	const cfg = path.join(f.root, "extra.gitconfig");
	writeFileSync(cfg, "[alias]\n\tci = commit\n");
	assert.equal(only(commitPlans(`export GIT_CONFIG_GLOBAL=${cfg}; git ci -m x`, f.opts)).dir, f.root);
	assert.equal(only(commitPlans(`export GIT_CONFIG_GLOBAL=${cfg} && cd a && git ci -m x`, f.opts)).dir, f.at("a"));
	assert.equal(only(commitPlans(`GIT_CONFIG_GLOBAL=${cfg}; export GIT_CONFIG_GLOBAL; git ci -m x`, f.opts)).dir, f.root, "export of an earlier assignment");
	assert.deepEqual(commitPlans("GIT_CONFIG_COUNT=1; GIT_CONFIG_KEY_0=alias.ci; GIT_CONFIG_VALUE_0=commit; git ci -m x", f.opts), [], "assigned but never exported: git doesn't see them");
	assert.equal(only(commitPlans("GIT_CONFIG_COUNT=1; GIT_CONFIG_KEY_0=alias.ci; GIT_CONFIG_VALUE_0=commit; export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; git ci -m x", f.opts)).dir, f.root, "then exported");
	assert.equal(only(commitPlans(`GIT_CONFIG_GLOBAL=${cfg}; git ci -m x`, f.opts)).dir, f.root, "assigning a variable that's already exported (the test env exports GIT_CONFIG_GLOBAL) changes what git sees");
	assert.deepEqual(commitPlans("export GIT_CONFIG_GLOBAL=$X; git ci", f.opts), [{ unparsable: "commit" }]);
	assert.deepEqual(commitPlans(`( export GIT_CONFIG_GLOBAL=${cfg} ); git ci -m x`, f.opts), [], "a subshell's export ends at )");
	assert.deepEqual(commitPlans(`export GIT_CONFIG_GLOBAL=${cfg} | cat; git ci -m x`, f.opts), [], "a pipeline stage's export doesn't carry over");
	assert.deepEqual(commitPlans(`export GIT_CONFIG_GLOBAL=${cfg}; unset GIT_CONFIG_GLOBAL; git ci -m x`, f.opts), [], "unset removes it");
	assert.deepEqual(commitPlans(`export GIT_CONFIG_GLOBAL=${cfg}; export -n GIT_CONFIG_GLOBAL; git ci -m x`, f.opts), [], "export -n un-exports it");
	assert.equal(only(commitPlans("export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=commit; git ci -m x", f.opts)).dir, f.root);
	assert.equal(only(commitPlans(`{ export GIT_CONFIG_GLOBAL=${cfg}; }; git ci -m x`, f.opts)).dir, f.root, "a { } group's export carries over");
});

test("real commands: a fixed list never spawns git; an unknown subcommand does; a failing --list-cmds only matters then", () => {
	const f = aliasFixture({ local: { ci: "commit" } });
	const counting = countingRunner();
	commitPlans("git status && git log && git push && git diff && git stash && git rev-parse HEAD && git cherry-pick x", { ...f.opts, runGit: counting.run });
	assert.deepEqual(counting.calls, [], "only listed commands: zero spawns");
	const failing = (args, o) => (args[0] === "--list-cmds=main,others" ? { status: 128, stdout: "", timedOut: false } : runGitDefault(args, o));
	assert.deepEqual(commitPlans("git status", { ...f.opts, runGit: failing }), [], "no plan, no ask");
	assert.deepEqual(commitPlans("git ci -m x", { ...f.opts, runGit: failing }), [{ unparsable: "commit" }], "an unknown subcommand needs the list");
});

// ---- #36: the content scan's own time budget ----
function scanRepo() {
	const dir = mkdtempSync(path.join(tmpdir(), "commit-content-scan-"));
	const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
	g("init", "-q", "-b", "main");
	g("config", "user.email", "t@example.invalid");
	g("config", "user.name", "T");
	writeFileSync(path.join(dir, "a.txt"), "one\n");
	g("add", ".");
	g("commit", "-qm", "init");
	writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
	writeFileSync(path.join(dir, "new.txt"), "fresh\n");
	return dir;
}
const planAll = { all: false, addAll: true, addTracked: false, addPaths: [] };

test("scan budget: within the budget, contentToCommit returns the same chunks as without one", () => {
	const dir = scanRepo();
	const plain = contentToCommit(dir, planAll);
	assert.deepEqual(contentToCommit(dir, planAll, scanBudget(10_000)), plain);
	assert.deepEqual(plain.map((c) => c.file).sort(), ["a.txt", "new.txt"]);
});

test("scan budget: a git call that times out throws ScanTimeout; every call gets at most the time left", () => {
	const dir = scanRepo();
	let t = 0;
	const timeouts = [];
	const runGit = (args, o) => {
		timeouts.push(o.timeout);
		if (args[0] === "diff" && !args.includes("--cached")) return { status: null, stdout: "", timedOut: true };
		t += 1_000; // the --cached diff "takes" 1 s
		return runGitDefault(args, o);
	};
	assert.throws(() => contentToCommit(dir, planAll, scanBudget(5_000, { now: () => t, runGit })), ScanTimeout);
	assert.deepEqual(timeouts, [5_000, 4_000]);
});

test("scan budget: a spent budget throws before running git, or before reading the next untracked file", () => {
	const dir = scanRepo();
	const calls = [];
	const runGit = (args, o) => (calls.push(args[0]), runGitDefault(args, o));
	assert.throws(() => contentToCommit(dir, planAll, scanBudget(0, { runGit })), ScanTimeout);
	assert.deepEqual(calls, [], "no git call once the budget is spent");
	let t = 0;
	const slowLs = (args, o) => {
		if (args[0] === "ls-files") t += 10_000; // listing untracked files used up the budget
		return runGitDefault(args, o);
	};
	assert.throws(() => contentToCommit(dir, planAll, scanBudget(5_000, { now: () => t, runGit: slowLs })), /untracked/);
});
