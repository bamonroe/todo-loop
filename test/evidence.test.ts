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
