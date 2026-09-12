import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { changedFiles, collectDiff, commitAll, gatherEvidence, headCommit, isTreeClean, runCommand } from "../src/evidence.ts";

let repo: string;
let base: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

before(async () => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-git-"));
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
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
	});
	assert.match(evidence.hardFailure ?? "", /No file changes/);
});

test("command output is captured and capped", async () => {
	const result = await runCommand(repo, "seq 1 5000", 20000, 500);
	assert.equal(result.ok, true);
	assert.ok(Buffer.byteLength(result.output) <= 600);
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
