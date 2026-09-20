import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { workerArgs } from "../src/cli.ts";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
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
	const before = loadStore(path.join(workspace, "todo.toml"));
	const result = await todo("run", "--dry-run", "--max", "5");
	assert.equal(result.code, 0);
	assert.match(result.stdout, /would run pi \(.+\) with prompt/);
	assert.match(result.stdout, /queue empty/);

	// A dry run prints prompts. It used to also mark every task done, which made
	// previewing a queue destroy it — and would commit a dirty tree on the way.
	const after = loadStore(path.join(workspace, "todo.toml"));
	assert.deepEqual(
		after.tasks.map((task) => `${task.id}=${task.status}`),
		before.tasks.map((task) => `${task.id}=${task.status}`),
	);
	assert.equal(after.loop.running, before.loop.running);
});

test("a dry run names the model the real run would use", async () => {
	// Which model the loop is about to spend tokens on is otherwise invisible
	// until it has spent them.
	const configured = await todo("run", "--dry-run", "--max", "1");
	assert.match(configured.stdout, /would run pi \(openai-codex\/gpt-5\.6-terra\) with prompt/);

	const overridden = await todo("run", "--dry-run", "--max", "1", "--model", "ollama/qwen3.8-27b");
	assert.match(overridden.stdout, /would run pi \(ollama\/qwen3\.8-27b\) with prompt/);

	// --provider alone re-points the configured model at another host.
	const rehosted = await todo("run", "--dry-run", "--max", "1", "--provider", "opencode");
	assert.match(rehosted.stdout, /would run pi \(opencode\/gpt-5\.6-terra\) with prompt/);
});

test("--dry-run previews a planning round as a planning round", async () => {
	assert.equal((await todo("add", "auth", "Rebuild the authentication system", "--level", "plan")).code, 0);
	// The plan is last in the queue, so the dry run has to walk to it.
	const result = await todo("run", "--dry-run", "--max", "20");
	assert.match(result.stdout, /plan next steps for — auth/);
	assert.match(result.stdout, /You are \*\*not\*\* implementing this/);
	// Still untouched afterwards.
	assert.equal(loadStore(path.join(workspace, "todo.toml")).tasks.at(-1)?.status, "todo");
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

test("the worker is launched with project-local files trusted", () => {
	// Without --approve, pi falls back to defaultProjectTrust and *silently*
	// skips the project's own .pi/settings.json. On a small local window that
	// file is what keeps compaction from retaining more than its own trigger
	// threshold, so losing it is a loop that compacts forever.
	const inherited = workerArgs({ ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models, worker: "inherit" } }, "p");
	assert.ok(inherited.args.includes("--approve"));
	assert.deepEqual(inherited.args, ["-p", "--approve", "--", "p"]);

	const pinned = workerArgs(parseConfig('[models]\nworker = "ollama/qwen3.8-27b"\n'), "p");
	assert.deepEqual(pinned.args, ["-p", "--approve", "--provider", "ollama", "--model", "qwen3.8-27b", "--", "p"]);
	assert.equal(pinned.model, "ollama/qwen3.8-27b");
});

test("the prompt stays behind the -- separator, whatever it starts with", () => {
	// A prompt beginning with a dash must never be read as a flag.
	const { args } = workerArgs(DEFAULT_CONFIG, "--version");
	assert.equal(args[args.length - 1], "--version");
	assert.equal(args[args.length - 2], "--");
});

/**
 * A real planning round, driven end to end with a fake `pi` on PATH.
 *
 * Everything above this either dry-runs (which never calls the verifier) or
 * tests the store directly, and both miss the whole of the accept path. A
 * planning round's check reloads the store from disk to see the rows the
 * worker just wrote, and anything the caller was still holding across that
 * call is a detached object whose mutations go nowhere.
 */
async function planningRound(
	script: string,
	options: { loop?: string; extraTasks?: string } = {},
): Promise<{ store: ReturnType<typeof loadStore>; stderr: string }> {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-round-"));
	const bin = path.join(repo, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(repo, "todoloop.toml"),
		`[models]\nworker = "ollama/fake"\nverifier = "ollama/fake"\n\n[loop]\ncheckpoint = "off"\n${options.loop ?? ""}`,
	);
	fs.writeFileSync(
		path.join(repo, "todo.toml"),
		`[loop]\nrunning = false\ncurrent = ""\niterations = 0\n\n[[task]]\nid = "eq"\ntitle = "Build the equalizer"\nlevel = "plan"\nstatus = "todo"\nattempts = 0\n${options.extraTasks ?? ""}`,
	);
	// The fake worker writes this round's items exactly as a real one would.
	fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });

	const result = await run(
		"node",
		["--experimental-strip-types", cli, "run", "--max", "1", "--cwd", repo],
		{ cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
	).catch((error: { stdout?: string; stderr?: string }) => error);

	return { store: loadStore(path.join(repo, "todo.toml")), stderr: result.stderr ?? "" };
}

test("an accepted planning round leaves the plan ready for its next round", async () => {
	const { store } = await planningRound(
		`node --experimental-strip-types ${cli} add eq.scaffold "Scaffold the Gradle project" --parent eq --level act --kind code --detail "app/build.gradle.kts" --cwd "$PWD" >/dev/null`,
	);

	const plan = store.tasks.find((t) => t.id === "eq");
	assert.ok(store.tasks.some((t) => t.id === "eq.scaffold"), "the round's item was kept");
	// "doing" here means the accept path mutated a detached copy: the plan is
	// left mid-flight and never comes back, which silently ends re-entrancy.
	assert.equal(plan?.status, "todo", "the plan goes back in the queue for its next round");
	assert.equal(store.loop.current, "");
});

test("a rejected planning round records the attempt against the plan", async () => {
	// A round of nothing but plans is rejected by the check. If the rejection is
	// written to a detached copy the attempt count never moves, so max_attempts
	// never trips and the same round is retried until the iteration cap.
	const { store } = await planningRound(
		`node --experimental-strip-types ${cli} add eq.storage "Decide how profiles persist" --parent eq --level plan --cwd "$PWD" >/dev/null`,
	);

	const plan = store.tasks.find((t) => t.id === "eq");
	assert.equal(plan?.attempts, 1, "the failed round is counted");
	assert.ok(store.loop.last_failure, "and the reason is kept for the retry prompt");
});

test("a round cut off after landing good items keeps them and continues next round", async () => {
	// Run 5: three well-ordered items written, then the clock. Discarding them to
	// retry from zero under identical conditions is how a productive round became
	// a failed one.
	const { store, stderr } = await planningRound(
		`node --experimental-strip-types ${cli} add eq.scaffold "Scaffold the Gradle project" --parent eq --level act --kind code --detail "app/build.gradle.kts" --cwd "$PWD" >/dev/null\nsleep 5`,
		{ loop: "plan_timeout_ms = 1500\n" },
	);

	assert.ok(store.tasks.some((t) => t.id === "eq.scaffold"), "the item it managed to write survives");
	assert.doesNotMatch(stderr, /discarded/, "nothing is discarded from a round that passed its check");
	assert.equal(store.tasks.find((t) => t.id === "eq")?.status, "todo", "the plan comes back for the rest");
});

test("a round cut off before writing anything never closes its plan", async () => {
	// checkPlanRound reads an empty round as the planner saying "no next step",
	// which is how a branch ends. On a timeout that reading is wrong: the clock
	// ran out, and accepting it would close the project on a stopwatch.
	const { store } = await planningRound("sleep 5", {
		loop: "plan_timeout_ms = 1500\n",
		extraTasks: '\n[[task]]\nid = "eq.init"\ntitle = "Initialise the repository"\nparent = "eq"\nstatus = "done"\nattempts = 0\n',
	});

	const plan = store.tasks.find((t) => t.id === "eq");
	assert.notEqual(plan?.status, "done", "a stopwatch must not finish a branch");
	assert.equal(plan?.attempts, 1, "it is a failed round, and counted as one");
});
