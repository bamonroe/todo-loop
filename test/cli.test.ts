import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { loadStore } from "../src/store.ts";

const run = promisify(execFile);
const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");

let workspace: string;

async function todo(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await run("node", ["--experimental-strip-types", cli, ...args, "--cwd", workspace], {
			cwd: workspace,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const err = error as { code?: number; stdout?: string; stderr?: string };
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

before(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-test-"));
});

after(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

test("init writes both files", async () => {
	const result = await todo("init");
	assert.equal(result.code, 0);
	assert.ok(fs.existsSync(path.join(workspace, "todoloop.toml")));
	assert.ok(fs.existsSync(path.join(workspace, "todo.toml")));

	// Turn off git and the model call for the rest of the run.
	const config = fs.readFileSync(path.join(workspace, "todoloop.toml"), "utf8");
	fs.writeFileSync(
		path.join(workspace, "todoloop.toml"),
		config.replace("enabled = true", "enabled = false").replace('checkpoint = "commit"', 'checkpoint = "off"'),
	);
	fs.writeFileSync(path.join(workspace, "todo.toml"), '[loop]\nrunning = false\n');
});

test("add, status and next", async () => {
	assert.equal((await todo("add", "api", "Build the API")).code, 0);
	assert.equal((await todo("add", "api.health", "Add a health endpoint", "--detail", "Return 200.")).code, 0);
	assert.equal((await todo("add", "api.metrics", "Add metrics")).code, 0);

	const status = await todo("status");
	assert.match(status.stdout, /api: Build the API/);
	assert.match(status.stdout, /3 todo/);

	const next = await todo("next", "--id");
	assert.equal(next.stdout.trim(), "api.health");

	const prompt = await todo("next");
	assert.match(prompt.stdout, /Working within: api: Build the API/);
	assert.match(prompt.stdout, /Return 200\./);
});

test("duplicate ids are rejected", async () => {
	const result = await todo("add", "api.health", "Again");
	assert.equal(result.code, 1);
	assert.match(result.stderr, /already exists/);
});

test("start claims the leftmost leaf", async () => {
	assert.equal((await todo("start")).code, 0);
	const store = loadStore(path.join(workspace, "todo.toml"));
	assert.equal(store.loop.current, "api.health");
	assert.equal(store.tasks[1].status, "doing");
});

test("complete closes the task and rolls the parent up", async () => {
	assert.equal((await todo("complete", "api.health", "added", "/health")).code, 0);
	assert.equal((await todo("complete", "api.metrics", "added", "metrics")).code, 0);
	const store = loadStore(path.join(workspace, "todo.toml"));
	assert.equal(store.tasks[0].status, "done");
	assert.equal(store.tasks[1].summary, "added /health");
});

test("next exits 3 when the queue is empty", async () => {
	const result = await todo("next");
	assert.equal(result.code, 3);
});

test("block then reset", async () => {
	await todo("add", "docs", "Write the README");
	assert.equal((await todo("block", "docs", "needs", "a", "spec")).code, 0);
	assert.equal((await todo("next")).code, 3);
	assert.equal((await todo("reset", "docs")).code, 0);
	assert.equal((await todo("next", "--id")).stdout.trim(), "docs");
});

test("run --dry-run drives the queue without launching a model", async () => {
	const result = await todo("run", "--dry-run", "--max", "5");
	assert.equal(result.code, 0);
	assert.match(result.stdout, /would run pi with prompt/);
	assert.match(result.stdout, /queue empty/);
	const store = loadStore(path.join(workspace, "todo.toml"));
	assert.equal(store.loop.running, false);
	assert.equal(store.tasks.every((task) => task.status === "done"), true);
});

test("unknown commands report usage", async () => {
	const result = await todo("frobnicate");
	assert.equal(result.code, 1);
	assert.match(result.stderr, /unknown command/);
});

test("a BLOCKED declaration is recognised in the worker's output", async () => {
	const { findBlockMarker } = await import("../src/cli.ts");
	assert.equal(
		findBlockMarker("I looked at the code.\nBLOCKED: the spec contradicts the existing schema"),
		"the spec contradicts the existing schema",
	);
	assert.equal(findBlockMarker("**BLOCKED**: no such module"), "no such module");
	assert.equal(findBlockMarker("Added greet.ts and a test. All good."), undefined);
	assert.equal(findBlockMarker("It is not blocked: everything worked"), undefined);
	// The last declaration wins, so a worker that changes its mind is honoured.
	assert.equal(findBlockMarker("BLOCKED: first guess\nActually:\nBLOCKED: the real reason"), "the real reason");
});

test("stop halts the loop between tasks", async () => {
	const store = path.join(workspace, "todo.toml");
	fs.writeFileSync(store, fs.readFileSync(store, "utf8").replace("running = false", "running = true"));
	assert.equal((await todo("stop")).code, 0);
	assert.equal(loadStore(store).loop.running, false);
});
