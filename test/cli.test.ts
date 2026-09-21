import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { workerArgs } from "../src/cli.ts";
import { evidenceFilePath } from "../src/evidence.ts";
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
	assert.deepEqual(inherited.args, ["-p", "--approve", "--mode", "json", "--", "p"]);

	const pinned = workerArgs(parseConfig('[models]\nworker = "ollama/qwen3.8-27b"\n'), "p");
	assert.deepEqual(pinned.args, ["-p", "--approve", "--mode", "json", "--provider", "ollama", "--model", "qwen3.8-27b", "--", "p"]);
	assert.equal(pinned.model, "ollama/qwen3.8-27b");
});

test("the worker is launched in JSON mode, whichever model it uses", () => {
	// Text mode printed the final message and nothing else, which is why run 13
	// could report that ten sessions overran but not what any of them did.
	for (const config of [DEFAULT_CONFIG, parseConfig('[models]\nworker = "ollama/qwen3.8-27b"\n')]) {
		const { args } = workerArgs(config, "p");
		assert.equal(args[args.indexOf("--mode") + 1], "json");
		assert.ok(args.indexOf("--mode") < args.indexOf("--"), "before the prompt separator, like every other flag");
	}
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
	options: { loop?: string; extraTasks?: string; atomic?: string; verify?: string } = {},
): Promise<{ store: ReturnType<typeof loadStore>; stdout: string; stderr: string }> {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-round-"));
	const bin = path.join(repo, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(repo, "todoloop.toml"),
		`[models]\nworker = "ollama/fake"\nverifier = "ollama/fake"\n\n[loop]\ncheckpoint = "off"\n${options.loop ?? ""}${options.atomic ?? ""}${options.verify ?? ""}`,
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

	return { store: loadStore(path.join(repo, "todo.toml")), stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The lines a real pi emits in `--mode json`, for a fake one to echo. */
function jsonSession(...events: unknown[]): string {
	const lines = [{ type: "session", version: 3, id: "fake", timestamp: "now", cwd: "." }, { type: "agent_start" }, { type: "turn_start" }, ...events, { type: "agent_end" }]
		.map((event) => JSON.stringify(event))
		.join("\n");
	return `cat <<'PIJSON'\n${lines}\nPIJSON`;
}

test("the driver reads a JSON session, and logs what it cost", async () => {
	const { store, stdout, stderr } = await planningRound(
		jsonSession(
			{ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "./gradlew assembleDebug" } },
			{ type: "tool_execution_end", toolCallId: "a", toolName: "bash", isError: false, result: "BUILD SUCCESSFUL" },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Wired the screen to the engine." }], usage: { input: 31_000, output: 900 } } },
		),
		{
			extraTasks: `\n[[task]]\nid = "eq.wire"\ntitle = "Wire the screen to the engine"\nparent = "eq"\nlevel = "act"\nkind = "code"\nstatus = "todo"\nattempts = 0\n`,
		},
	);

	// Run 13 recorded nothing but "exceeded its budget" for ten killed sessions.
	// An ordinary session's cost is what makes an overrun legible at all.
	assert.match(stdout, /\[todo-loop\] session: 1 tool call \(bash×1\), 1 turn, 31k context \/ 900 out/);
	assert.match(stdout, /→ bash \.\/gradlew assembleDebug/, "the tool calls stream as they happen");
	assert.doesNotMatch(stdout, /"type":"tool_execution_start"/, "and the raw events do not");
	assert.notEqual(store.tasks.find((t) => t.id === "eq.wire")?.status, "blocked");
	assert.doesNotMatch(stderr, /blocked by the worker/);
});

test("BLOCKED counts when the worker says it, not when a tool result contains it", async () => {
	// Text mode handed the whole stream to the regex, so a grep hit or a diff
	// line was indistinguishable from a refusal — and a false positive halts the
	// entire run, not just the task.
	const { store, stderr } = await planningRound(
		jsonSession(
			{ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "grep -rn BLOCKED ." } },
			{ type: "tool_execution_end", toolCallId: "a", toolName: "bash", isError: false, result: "NOTES.md:9:BLOCKED: an old note about a task we finished" },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Nothing to change; the note is stale." }] } },
		),
		{ extraTasks: `\n[[task]]\nid = "eq.wire"\ntitle = "Wire the screen"\nparent = "eq"\nlevel = "act"\nkind = "code"\nstatus = "todo"\nattempts = 0\n` },
	);

	assert.notEqual(store.tasks.find((t) => t.id === "eq.wire")?.status, "blocked");
	assert.doesNotMatch(stderr, /blocked by the worker/);
});

test("a BLOCKED declaration in an assistant message still halts the run", async () => {
	const { store, stderr } = await planningRound(
		jsonSession({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "BLOCKED: an unprivileged app cannot equalize system audio" }] },
		}),
		{ extraTasks: `\n[[task]]\nid = "eq.wire"\ntitle = "Wire the screen"\nparent = "eq"\nlevel = "act"\nkind = "code"\nstatus = "todo"\nattempts = 0\n` },
	);

	const act = store.tasks.find((t) => t.id === "eq.wire");
	assert.equal(act?.status, "blocked");
	assert.match(stderr, /blocked by the worker: an unprivileged app cannot equalize system audio/);
});

test("the last thing a worker said counts even without its closing newline", async () => {
	// A killed session's stdout ends mid-stream, and the last line is exactly
	// the one worth having. Without the flush at close it is dropped, and a
	// refusal the worker did make reads as a worker that said nothing.
	const last = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"BLOCKED: the emulator never booted"}]}}';
	const { store, stderr } = await planningRound(`printf '%s\\n%s' '{"type":"agent_start"}' '${last}'`, {
		extraTasks: `\n[[task]]\nid = "eq.wire"\ntitle = "Wire the screen"\nparent = "eq"\nlevel = "act"\nkind = "code"\nstatus = "todo"\nattempts = 0\n`,
	});

	assert.equal(store.tasks.find((t) => t.id === "eq.wire")?.status, "blocked");
	assert.match(stderr, /blocked by the worker: the emulator never booted/);
});

test("a killed worker's rejection says what it was doing when the clock ran out", async () => {
	// The dominant cost of run 13, and the driver's entire record of it was the
	// budget it had exceeded.
	const { store, stderr } = await planningRound(
		`${jsonSession({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "./gradlew connectedAndroidTest" } })}\nsleep 5`,
		{
			loop: "worker_timeout_ms = 1500\n",
			atomic: '\n[atomic]\non_overflow = "promote"\n',
			extraTasks: `\n[[task]]\nid = "eq.wire"\ntitle = "Wire the screen"\nparent = "eq"\nlevel = "act"\nkind = "code"\nstatus = "todo"\nattempts = 0\n`,
		},
	);

	assert.match(stderr, /exceeded its 1500ms budget; stopping it — .*still inside bash after \d+s/);
	const act = store.tasks.find((t) => t.id === "eq.wire");
	// It reaches the record the promote decision is reviewed from, too.
	assert.match(act?.overflow_reason ?? "", /still inside bash/);
});

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

test("project packages isolate the worker's extensions", () => {
	const config = parseConfig('[project]\npackages = ["../pi/android", "./local-ext"]\n');
	const { args } = workerArgs(config, "prompt");
	// Discovery off, explicit paths in, and all of it before the prompt separator.
	const separator = args.indexOf("--");
	assert.ok(args.indexOf("--no-extensions") > -1 && args.indexOf("--no-extensions") < separator);
	assert.deepEqual(
		args.filter((_, i) => args[i - 1] === "-e"),
		["../pi/android", "./local-ext"],
	);

	// No packages: pi's global discovery is left entirely alone.
	const bare = workerArgs(parseConfig(""), "prompt");
	assert.ok(!bare.args.includes("--no-extensions"));
	assert.ok(!bare.args.includes("-e"));
});

test("the project section parses and filters junk", () => {
	const config = parseConfig('[project]\npackages = ["a", 3, ""]\nsetup_command = "boot-emulator"\nteardown_command = "kill-emulator"\n');
	assert.deepEqual(config.project, { packages: ["a"], setup_command: "boot-emulator", teardown_command: "kill-emulator" });
	assert.deepEqual(parseConfig("").project, { packages: [], setup_command: "", teardown_command: "" });
});

/**
 * Run 10's ninety-minute dead end. An act timed out, came back with no file
 * changes, timed out again and blocked the whole run. Promotion is exactly the
 * remedy, and it never fired: overflow was only ever set from a finished diff's
 * file count or from compaction, and a killed worker produces neither.
 *
 * `max_attempts = 1` so one rejection spends the budget: promotion waits for
 * the attempts to run out, which is the whole of the test below this one.
 */
test("an act that has spent its attempts and overran becomes a plan", async () => {
	const { store, stderr } = await planningRound("sleep 5", {
		loop: "worker_timeout_ms = 1500\n",
		atomic: '\n[atomic]\non_overflow = "promote"\n',
		verify: "\n[verify]\nmax_attempts = 1\n",
		extraTasks: `\n[[task]]\nid = "eq.wire"\ntitle = "Wire the screen to the engine"\nparent = "eq"\nlevel = "act"\nkind = "code"\nstatus = "todo"\nattempts = 0\n`,
	});

	const act = store.tasks.find((t) => t.id === "eq.wire");
	assert.equal(act?.level, "plan", "the act becomes a plan so its next steps get decided");
	assert.equal(act?.status, "todo", "and goes back in the queue");
	assert.equal(act?.attempts, 0, "with the failed attempt cleared — it is not the same task any more");
	assert.match(stderr, /promoted to plan/);
});

/**
 * Run 12. A scaffold was rejected once, for a reason that had nothing to do
 * with its size, and because a Gradle/Compose scaffold inherently touches
 * twelve files the single rejection converted a nearly-right task into a plan
 * with two attempts unspent. One rejection is ordinary; three is the signal.
 */
test("one rejection does not promote an oversized act while attempts remain", async () => {
	const { store, stderr } = await planningRound("sleep 5", {
		loop: "worker_timeout_ms = 1500\n",
		atomic: '\n[atomic]\non_overflow = "promote"\n',
		verify: "\n[verify]\nmax_attempts = 3\n",
		extraTasks: `\n[[task]]\nid = "eq.wire"\ntitle = "Wire the screen to the engine"\nparent = "eq"\nlevel = "act"\nkind = "code"\nstatus = "todo"\nattempts = 0\n`,
	});

	const act = store.tasks.find((t) => t.id === "eq.wire");
	assert.equal(act?.overflowed, true, "the overrun is still recorded");
	// "act" is the default level and is not written back, so absence is the assertion.
	assert.notEqual(act?.level, "plan", "but the task keeps its remaining attempts");
	assert.equal(act?.attempts, 1);
	assert.ok(!/promoted to plan/.test(stderr));
});

/**
 * An attempt must be judged on its own tool output. Without the truncate, the
 * install a *rejected* attempt managed would still be sitting in the file when
 * the retry is verified, and the retry would be credited with work it never did
 * — the precise failure this channel exists to prevent, inverted.
 */
test("each session starts with an empty evidence file", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-stale-"));
	const bin = path.join(repo, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(repo, "todoloop.toml"),
		'[models]\nworker = "ollama/fake"\nverifier = "ollama/fake"\n\n[loop]\ncheckpoint = "off"\n',
	);
	fs.writeFileSync(
		path.join(repo, "todo.toml"),
		'[loop]\nrunning = false\ncurrent = ""\niterations = 0\n\n[[task]]\nid = "eq"\ntitle = "Build the equalizer"\nlevel = "plan"\nstatus = "todo"\nattempts = 0\n',
	);
	fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\ntrue\n", { mode: 0o755 });

	const evidence = evidenceFilePath(repo);
	fs.writeFileSync(evidence, "### android_install\nInstalled by an attempt that was thrown away.\n");

	await run("node", ["--experimental-strip-types", cli, "run", "--max", "1", "--cwd", repo], {
		cwd: repo,
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	}).catch((error: unknown) => error);

	assert.ok(!fs.readFileSync(evidence, "utf8").includes("thrown away"), "the previous attempt's evidence is gone");
	fs.rmSync(evidence, { force: true });
});

test("the overrun is recorded even when on_overflow only warns", async () => {
	const { store } = await planningRound("sleep 5", {
		loop: "worker_timeout_ms = 1500\n",
		extraTasks: `\n[[task]]\nid = "eq.wire"\ntitle = "Wire the screen to the engine"\nparent = "eq"\nlevel = "act"\nkind = "code"\nstatus = "todo"\nattempts = 0\n`,
	});

	const act = store.tasks.find((t) => t.id === "eq.wire");
	assert.equal(act?.overflowed, true, "the clock is a size signal like any other");
	assert.match(act?.overflow_reason ?? "", /1500ms budget/);
	assert.notEqual(act?.level, "plan", "but warn leaves the queue alone");
	assert.equal(act?.attempts, 1);
});

test("a planning round that runs long is not treated as oversized", async () => {
	// A short round is not a broken one — timedOutRound judges those on what they
	// landed, and promoting a plan for running long would restructure the queue
	// every time the planner was slow.
	const { store } = await planningRound("sleep 5", {
		loop: "plan_timeout_ms = 1500\n",
		atomic: '\n[atomic]\non_overflow = "promote"\n',
	});

	const plan = store.tasks.find((t) => t.id === "eq");
	assert.notEqual(plan?.overflowed, true);
});
