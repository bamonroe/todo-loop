import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import {
	changedFiles,
	collectDiff,
	commitAll,
	formatEvidence,
	gatherEvidence,
	headCommit,
	isTreeClean,
	loopOwnedPaths,
	revertTo,
	runCommand,
} from "../src/evidence.ts";

let repo: string;
let base: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

before(async () => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-git-"));
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	fs.writeFileSync(path.join(repo, "todo.toml"), "[loop]\nrunning = false\n");
	fs.writeFileSync(path.join(repo, "server.ts"), "export const port = 3000;\n");
	git("add", "-A");
	git("commit", "-qm", "initial");
	base = await headCommit(repo);
});

after(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

test("a clean tree produces no diff", async () => {
	assert.equal(await isTreeClean(repo), true);
	const { diff, files } = await collectDiff(repo, base, 10000);
	assert.equal(diff, "(no changes)");
	assert.equal(files.length, 0);
});

test("uncommitted edits and new files both show up", async () => {
	fs.appendFileSync(path.join(repo, "server.ts"), "export const host = 'localhost';\n");
	fs.writeFileSync(path.join(repo, "health.ts"), "export const health = () => 'ok';\n");

	const { diff, files, dirty } = await collectDiff(repo, base, 20000);
	assert.equal(dirty, true);
	assert.match(diff, /uncommitted working tree/);
	assert.match(diff, /host = 'localhost'/);
	assert.match(diff, /untracked files/);
	// The contents of a new file must actually reach the verifier: new files are
	// the most common result of a task, and "binary or unreadable" tells it nothing.
	assert.match(diff, /\+\+\+ b\/health\.ts/);
	assert.match(diff, /\+export const health = \(\) => 'ok';/);
	assert.deepEqual(files.sort(), ["health.ts", "server.ts"]);
	assert.deepEqual((await changedFiles(repo, base)).sort(), ["health.ts", "server.ts"]);
});

test("committed work still counts against the task base", async () => {
	await commitAll(repo, "todo(api.health): add health");
	assert.equal(await isTreeClean(repo), true);
	const { diff, files } = await collectDiff(repo, base, 20000);
	assert.match(diff, /committed since task start/);
	assert.deepEqual(files.sort(), ["health.ts", "server.ts"]);
});

test("a failing command short-circuits verification", async () => {
	const evidence = await gatherEvidence({
		cwd: repo,
		baseCommit: base,
		testCommand: "exit 7",
		buildCommand: "",
		requireTestsPass: true,
		timeoutMs: 10000,
		maxBytes: 12000,
		maxDiffBytes: 48000,
	});
	assert.match(evidence.hardFailure ?? "", /exit 7/);
});

test("no changes at all is itself a hard failure", async () => {
	const now = await headCommit(repo);
	const evidence = await gatherEvidence({
		cwd: repo,
		baseCommit: now,
		testCommand: "true",
		buildCommand: "",
		requireTestsPass: true,
		timeoutMs: 10000,
		maxBytes: 12000,
		maxDiffBytes: 48000,
	});
	assert.match(evidence.hardFailure ?? "", /No file changes/);
});

test("command output is captured and capped", async () => {
	const result = await runCommand(repo, "seq 1 5000", 20000, 500);
	assert.equal(result.ok, true);
	// The budget bounds the kept output; the marker explaining the cut sits on
	// top of it, so measure the body rather than the whole string.
	const body = result.output.split("\n").filter((line) => !line.includes("truncated by todo-loop")).join("\n");
	assert.ok(Buffer.byteLength(body) <= 500, `body was ${Buffer.byteLength(body)} bytes`);
	assert.match(result.output, /5000/);

	const failure = await runCommand(repo, "echo boom >&2; exit 3", 20000, 500);
	assert.equal(failure.ok, false);
	assert.equal(failure.code, 3);
	assert.match(failure.output, /boom/);
});

test("a non-git directory degrades instead of throwing", async () => {
	const plain = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-plain-"));
	const { diff, files } = await collectDiff(plain, "", 1000);
	assert.match(diff, /not a git repository/);
	assert.equal(files.length, 0);
	fs.rmSync(plain, { recursive: true, force: true });
});

test("the queue and its config are kept out of the evidence", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-exclude-"));
	execFileSync("git", ["init", "-q"], { cwd: scratch });
	execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: scratch });
	execFileSync("git", ["config", "user.name", "T"], { cwd: scratch });
	fs.writeFileSync(path.join(scratch, "README.md"), "scratch\n");
	execFileSync("git", ["add", "-A"], { cwd: scratch });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd: scratch });

	// Only the loop's own bookkeeping changed — that must not read as work done.
	fs.writeFileSync(path.join(scratch, "todo.toml"), "[loop]\nrunning = true\n");
	fs.writeFileSync(path.join(scratch, "todoloop.toml"), "[models]\nworker = \"inherit\"\n");

	const bookkeepingOnly = await collectDiff(scratch, "", 10000);
	assert.equal(bookkeepingOnly.diff, "(no changes)");
	assert.equal(bookkeepingOnly.files.length, 0);
	assert.equal(bookkeepingOnly.dirty, false);

	fs.writeFileSync(path.join(scratch, "greet.ts"), "export const greet = () => 'hi';\n");
	const withWork = await collectDiff(scratch, "", 10000);
	assert.deepEqual(withWork.files, ["greet.ts"]);
	assert.doesNotMatch(withWork.diff, /running = true/);
	assert.equal(withWork.dirty, true);
	assert.deepEqual(await changedFiles(scratch, ""), ["greet.ts"]);

	fs.rmSync(scratch, { recursive: true, force: true });
});

test("a binary new file is named rather than dumped", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-binary-"));
	execFileSync("git", ["init", "-q"], { cwd: scratch });
	fs.writeFileSync(path.join(scratch, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
	const { diff } = await collectDiff(scratch, "", 10000);
	assert.match(diff, /new file blob\.bin \(binary, 4 bytes\)/);
	fs.rmSync(scratch, { recursive: true, force: true });
});

test("a commit keeps its subject on one line", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-commit-"));
	execFileSync("git", ["init", "-q"], { cwd: scratch });
	execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: scratch });
	execFileSync("git", ["config", "user.name", "T"], { cwd: scratch });
	fs.writeFileSync(path.join(scratch, "greet.ts"), "export const greet = () => 'hi';\n");

	const body = "The diff creates greet.ts with the correct signature.\nIt also adds a test.";
	assert.equal(await commitAll(scratch, `todo(greet): Add a greet function\n\n${body}`), true);

	const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: scratch, encoding: "utf8" }).trim();
	assert.equal(subject, "todo(greet): Add a greet function");
	assert.match(execFileSync("git", ["log", "-1", "--format=%b"], { cwd: scratch, encoding: "utf8" }), /also adds a test/);

	fs.rmSync(scratch, { recursive: true, force: true });
});

test("the loop's own state file does not count as a dirty tree", async () => {
	// The bug this pins: `todo run` writes its state file before the first
	// iteration, then checked cleanliness — so it refused to start on dirt it
	// had just made itself, on every repo where that file was not yet committed.
	const sidecar = path.join(repo, "TODO.todoloop-state.toml");
	fs.writeFileSync(sidecar, "task = []\n");
	try {
		assert.equal(await isTreeClean(repo), false);
		assert.equal(await isTreeClean(repo, ["TODO.todoloop-state.toml"]), true);

		// Real work alongside it still stops the loop.
		fs.writeFileSync(path.join(repo, "server.ts"), "export const port = 4000;\n");
		assert.equal(await isTreeClean(repo, ["TODO.todoloop-state.toml"]), false);
	} finally {
		fs.rmSync(sidecar, { force: true });
		git("checkout", "--", "server.ts");
	}
});

test("loopOwnedPaths lists the queue relative to the repo, and nothing outside it", () => {
	const owned = loopOwnedPaths(repo, [
		path.join(repo, "TODO.toml"),
		path.join(repo, "FINISHED.toml"),
		path.join(repo, "TODO.todoloop-state.toml"),
		"/somewhere/else/todo.toml",
		undefined,
	]);
	assert.deepEqual(owned, [
		"TODO.toml",
		"FINISHED.toml",
		"TODO.todoloop-state.toml",
		"todo.toml",
		"todoloop.toml",
	]);
});

test("a single excluded modification still reads as clean", async () => {
	// The loop writes its own queue file before it checks the tree, so this is
	// the ordinary path, not an edge case. Porcelain reports an unstaged edit as
	// " M path" with a blank first status column: trimming the whole output
	// instead of each line shifts that path two characters and the exclusion
	// silently stops matching.
	await commitAll(repo, "seed the queue file");
	fs.appendFileSync(path.join(repo, "todo.toml"), "\nrunning = true\n");

	assert.equal(await isTreeClean(repo), false);
	assert.equal(await isTreeClean(repo, ["todo.toml"]), true);
});

test("an excluded file first in the list does not cover an unexcluded one after it", async () => {
	fs.writeFileSync(path.join(repo, "src.ts"), "export const real = 1;\n");
	assert.equal(await isTreeClean(repo, ["todo.toml"]), false);
	assert.equal(await isTreeClean(repo, ["todo.toml", "src.ts"]), true);
	fs.rmSync(path.join(repo, "src.ts"));
	git("checkout", "--", "todo.toml");
});

/**
 * The retry path is only real if a rejected attempt's edits go away. These use
 * their own repo: the shared one above is mutated by every test in file order,
 * and a hard reset in the middle of that would be a trap for the next author.
 */
test("reverting a rejected attempt restores the tree and lets the next one start", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-revert-"));
	try {
		const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
		run("init", "-q");
		run("config", "user.email", "test@example.com");
		run("config", "user.name", "Test");
		fs.writeFileSync(path.join(dir, ".gitignore"), ".todoloop-state.toml\n");
		fs.writeFileSync(path.join(dir, "Band.kt"), "val bands = 5\n");
		run("add", "-A");
		run("commit", "-qm", "initial");
		const start = await headCommit(dir);

		// What a worker leaves behind when its code does not compile: an edit, a
		// new file, and the loop's own gitignored state.
		fs.writeFileSync(path.join(dir, "Band.kt"), "val bands = min(5, 10)\n");
		fs.writeFileSync(path.join(dir, "BandTest.kt"), "// broken\n");
		fs.writeFileSync(path.join(dir, ".todoloop-state.toml"), "attempts = 1\n");
		assert.equal(await isTreeClean(dir), false);

		assert.equal(await revertTo(dir, start), true);

		assert.equal(await isTreeClean(dir), true, "the next iteration's require-clean gate must pass");
		assert.equal(fs.readFileSync(path.join(dir, "Band.kt"), "utf8"), "val bands = 5\n");
		assert.equal(fs.existsSync(path.join(dir, "BandTest.kt")), false);
		assert.equal(await headCommit(dir), start, "revert must not move HEAD");
		assert.equal(
			fs.existsSync(path.join(dir, ".todoloop-state.toml")),
			true,
			"clean without -x: losing the attempt count would defeat the retry this enables",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("revert refuses when something committed behind the loop's back", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-revert-head-"));
	try {
		const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
		run("init", "-q");
		run("config", "user.email", "test@example.com");
		run("config", "user.name", "Test");
		fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
		run("add", "-A");
		run("commit", "-qm", "initial");
		const start = await headCommit(dir);

		fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
		run("add", "-A");
		run("commit", "-qm", "someone else committed");
		fs.writeFileSync(path.join(dir, "a.txt"), "three\n");

		assert.equal(await revertTo(dir, start), false, "discarding an unexpected commit is not this function's call");
		assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "three\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("revert with no base commit is a no-op", async () => {
	assert.equal(await revertTo(repo, ""), false);
});

test("a documentation-only diff does not run the build or the tests", async () => {
	await commitAll(repo, "todo(x): settle the tree");
	const now = await headCommit(repo);
	fs.writeFileSync(path.join(repo, "NOTES.md"), "# Project notes\n\nAcceptance: the build is green.\n");

	// Commands that fail loudly: if they run at all, this task is rejected —
	// which is exactly what run 11 did to an act that only wrote NOTES.md.
	const evidence = await gatherEvidence({
		cwd: repo,
		baseCommit: now,
		buildCommand: "exit 9",
		testCommand: "exit 9",
		requireTestsPass: true,
		timeoutMs: 10000,
		maxBytes: 12000,
		maxDiffBytes: 48000,
	});

	assert.equal(evidence.hardFailure, undefined);
	assert.deepEqual(evidence.files, ["NOTES.md"]);
	// Named in the evidence, not silently missing.
	assert.equal(evidence.commands.length, 2);
	for (const command of evidence.commands) {
		assert.equal(command.ok, true);
		assert.match(command.output, /not run/);
	}
});

test("one code file in the diff is enough to run them again", async () => {
	await commitAll(repo, "todo(x): keep the notes");
	const now = await headCommit(repo);
	fs.appendFileSync(path.join(repo, "NOTES.md"), "\nAnd a second line.\n");
	fs.appendFileSync(path.join(repo, "server.ts"), "export const tls = false;\n");

	const evidence = await gatherEvidence({
		cwd: repo,
		baseCommit: now,
		buildCommand: "exit 9",
		testCommand: "",
		requireTestsPass: true,
		timeoutMs: 10000,
		maxBytes: 12000,
		maxDiffBytes: 48000,
	});

	assert.deepEqual(evidence.files.sort(), ["NOTES.md", "server.ts"]);
	assert.match(evidence.hardFailure ?? "", /exit 9/);
});

test("an empty diff is not documentation-only, so the commands still run", async () => {
	await commitAll(repo, "todo(x): land the code too");
	const now = await headCommit(repo);

	const evidence = await gatherEvidence({
		cwd: repo,
		baseCommit: now,
		buildCommand: "exit 9",
		testCommand: "",
		requireTestsPass: true,
		timeoutMs: 10000,
		maxBytes: 12000,
		maxDiffBytes: 48000,
	});

	// The command failure is what surfaces, which can only happen if it ran.
	assert.match(evidence.hardFailure ?? "", /exit 9/);
});

test("tool evidence recorded during the session reaches the verifier", async () => {
	await commitAll(repo, "todo(x): settle before the evidence tests");
	const now = await headCommit(repo);
	fs.appendFileSync(path.join(repo, "server.ts"), "export const ready = true;\n");

	const file = path.join(repo, "..", `tool-evidence-${process.pid}.md`);
	fs.writeFileSync(file, "### android_install\nInstalled app-debug.apk.\n");

	const evidence = await gatherEvidence({
		cwd: repo,
		baseCommit: now,
		buildCommand: "true",
		testCommand: "",
		requireTestsPass: true,
		timeoutMs: 10000,
		maxBytes: 12000,
		maxDiffBytes: 48000,
		evidenceFile: file,
	});

	assert.match(evidence.toolEvidence ?? "", /Installed app-debug\.apk/);
	// It has to survive into what the verifier actually reads, labelled as the
	// tools' own output — a claim in the diff is what this exists to replace.
	const rendered = formatEvidence({ id: "eq.scaffold", title: "Scaffold" }, evidence);
	assert.match(rendered, /## Tool evidence recorded during the session/);
	assert.match(rendered, /not the worker's account of it/);
	assert.match(rendered, /Installed app-debug\.apk/);
	fs.rmSync(file, { force: true });
});

test("no evidence file is ordinary, not an error", async () => {
	const now = await headCommit(repo);
	fs.appendFileSync(path.join(repo, "server.ts"), "export const port2 = 3001;\n");

	const evidence = await gatherEvidence({
		cwd: repo,
		baseCommit: now,
		buildCommand: "true",
		testCommand: "",
		requireTestsPass: true,
		timeoutMs: 10000,
		maxBytes: 12000,
		maxDiffBytes: 48000,
		evidenceFile: path.join(repo, "nothing-was-recorded.md"),
	});

	assert.equal(evidence.toolEvidence, undefined);
	assert.equal(evidence.hardFailure, undefined);
	assert.ok(!formatEvidence({ id: "eq.x", title: "X" }, evidence).includes("Tool evidence"));
});

test("the diff gets its own budget instead of a third of the evidence budget", async () => {
	// A research act's whole work product is its notes append. At the old
	// maxBytes/3 this was cut to 4000 bytes and the verifier rejected the cut.
	const notes = `# Notes\n${"a fact that earlier sessions worked out. ".repeat(500)}\n`;
	assert.ok(Buffer.byteLength(notes) > 12000, "fixture must exceed the whole evidence budget");
	fs.writeFileSync(path.join(repo, "NOTES.md"), notes);

	const evidence = await gatherEvidence({
		cwd: repo,
		baseCommit: base,
		testCommand: "",
		buildCommand: "",
		requireTestsPass: false,
		timeoutMs: 10000,
		maxBytes: 12000,
		maxDiffBytes: 48000,
	});

	assert.doesNotMatch(evidence.diff, /truncated by todo-loop/);
	// The end of the append has to survive: it is where sections (c) and (d) were.
	assert.match(evidence.diff, /a fact that earlier sessions worked out\. $/m);

	fs.rmSync(path.join(repo, "NOTES.md"));
});

test("the diff budget is still a cap, so a self-hosted verifier cannot be flooded", async () => {
	const huge = `${"z".repeat(200_000)}\n`;
	fs.writeFileSync(path.join(repo, "HUGE.md"), huge);

	const evidence = await gatherEvidence({
		cwd: repo,
		baseCommit: base,
		testCommand: "",
		buildCommand: "",
		requireTestsPass: false,
		timeoutMs: 10000,
		maxBytes: 12000,
		maxDiffBytes: 48000,
	});

	assert.match(evidence.diff, /truncated by todo-loop/);
	assert.ok(Buffer.byteLength(evidence.diff) < 60_000, `diff was ${Buffer.byteLength(evidence.diff)} bytes`);

	fs.rmSync(path.join(repo, "HUGE.md"));
});

test("a command runs in the environment it was handed", async () => {
	// The whole point of [env]: a project's build command sees what the project
	// declared, not what the terminal that started the run happened to export.
	const result = await runCommand(process.cwd(), "echo \"[$TODOLOOP_TEST_VAR]\"", 20000, 500, {
		...process.env,
		TODOLOOP_TEST_VAR: "applied",
	});
	assert.equal(result.ok, true);
	assert.match(result.output, /\[applied\]/);

	const without = await runCommand(process.cwd(), "echo \"[$TODOLOOP_TEST_VAR]\"", 20000, 500);
	assert.match(without.output, /\[\]/, "and no environment argument leaves the process's own alone");
});

test("the build and test commands run in the environment the caller declared", async () => {
	// The [env] table exists to point a project's tooling at the project, and
	// the verifier's commands are the half of the loop most likely to need it:
	// a build script that cannot find the project fails every task for a reason
	// that has nothing to do with the task.
	const evidence = await gatherEvidence({
		cwd: repo,
		baseCommit: base,
		testCommand: "",
		buildCommand: "echo \"[$TODOLOOP_TEST_VAR]\"",
		requireTestsPass: false,
		timeoutMs: 20000,
		maxBytes: 12000,
		maxDiffBytes: 48000,
		env: { ...process.env, TODOLOOP_TEST_VAR: "declared" },
	});
	const build = evidence.commands.find((command) => command.command.includes("TODOLOOP_TEST_VAR"));
	assert.ok(build, "the build command ran");
	assert.match(build.output, /\[declared\]/);
});
