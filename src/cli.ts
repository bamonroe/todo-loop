#!/usr/bin/env -S node --experimental-strip-types
/**
 * todo — queue management plus the shell driver.
 *
 * The driver is the version that fails where you can see it: one `pi -p`
 * process per task, so "clear the context" is process exit rather than
 * session bookkeeping.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_CONFIG_FILE,
	inheritsWorker,
	loadConfig,
	splitModelRef,
	withWorkerOverride,
	type Config,
} from "./config.ts";
import { diagnose, formatChecks } from "./doctor.ts";
import { commitAll, gatherEvidence, headCommit, isGitRepo, isTreeClean, loopOwnedPaths } from "./evidence.ts";
import { renderAssignmentPrompt } from "./prompt.ts";
import { checkDecomposition } from "./decompose.ts";
import {
	allowedChildLevels,
	assignmentFor,
	blockedLeaves,
	counts,
	createTask,
	DEFAULT_STORE_FILE,
	effectiveLevel,
	findTask,
	insertChildren,
	levelOf,
	markOverflow,
	promoteToScope,
	loadStore,
	markBlocked,
	markDoing,
	markDone,
	nextLeaf,
	recordFailure,
	renderTree,
	resolveStorePath,
	rollup,
	saveStore,
	type Store,
	type Task,
} from "./store.ts";
import { completerFor } from "./providers.ts";
import { verify, type Verdict } from "./verify.ts";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_EMPTY = 3;
const EXIT_REJECTED = 4;

interface Flags {
	positional: string[];
	options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Flags {
	const positional: string[] = [];
	const options: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const body = arg.slice(2);
		const eq = body.indexOf("=");
		if (eq >= 0) {
			options[body.slice(0, eq)] = body.slice(eq + 1);
		} else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
			options[body] = argv[++i];
		} else {
			options[body] = true;
		}
	}
	return { positional, options };
}

function str(flags: Flags, key: string, fallback = ""): string {
	const value = flags.options[key];
	return typeof value === "string" ? value : fallback;
}

function bool(flags: Flags, key: string): boolean {
	return flags.options[key] === true || flags.options[key] === "true";
}

interface Env {
	cwd: string;
	config: Config;
	storeFile: string;
	store: Store;
}

function loadEnv(flags: Flags): Env {
	const cwd = path.resolve(str(flags, "cwd", process.cwd()));
	// The worker comes from the config file, and --provider/--model override it
	// here rather than in `run` alone, so `todo doctor` reports the model the run
	// would actually use.
	const config = withWorkerOverride(
		loadConfig(cwd, str(flags, "config") || undefined),
		str(flags, "provider") || undefined,
		str(flags, "model") || undefined,
	);
	const storeFile = resolveStorePath(cwd, str(flags, "file") || undefined);
	return { cwd, config, storeFile, store: loadStore(storeFile) };
}

/**
 * Paths whose changes are the loop's bookkeeping rather than the task's work.
 *
 * The queue changes on every task, so showing it to the verifier makes a task
 * that touched nothing else look like it did something. Which files those are
 * depends on the schema — a project queue is three files, not one — so the list
 * is built from the store rather than fixed.
 */
function queueExcludes(env: Env): string[] {
	return loopOwnedPaths(env.cwd, [env.storeFile, env.store.archive?.file, env.store.sidecarFile]);
}

function verifierFor(env: Env, signal?: AbortSignal) {
	return completerFor(env.config.models.verifier, env.config, signal);
}

async function evidenceFor(env: Env) {
	return gatherEvidence({
		cwd: env.cwd,
		baseCommit: env.store.loop.base_commit,
		testCommand: env.config.verify.test_command,
		buildCommand: env.config.verify.build_command,
		requireTestsPass: env.config.verify.require_tests_pass,
		timeoutMs: env.config.verify.timeout_ms,
		maxBytes: env.config.verify.max_evidence_bytes,
		exclude: queueExcludes(env),
	});
}

/**
 * A breakdown is checked against the store and the diff; an implementation is
 * checked by a model. Both are gated on the same evidence, so this is the only
 * place that has to know which kind of work just happened.
 */
async function verifyTask(env: Env, task: Task, signal?: AbortSignal): Promise<Verdict> {
	const decomposing = assignmentFor(task) === "decompose";

	if (decomposing) {
		// Re-read: the worker added children through the CLI, so the in-memory
		// store is stale by exactly the rows that decide this verdict.
		env.store = loadStore(env.storeFile);
		const current = findTask(env.store, task.id) ?? task;
		const evidence = await evidenceFor(env);
		return checkDecomposition(env.store, current, evidence.files, env.config);
	}

	if (!env.config.verify.enabled) return { pass: true, reason: "Verification disabled.", mechanical: true };
	const evidence = await evidenceFor(env);
	noteOverflow(env, task, evidence.files);
	return verify(task, evidence, verifierFor(env, signal));
}

/**
 * Flag a leaf that touched more files than its budget.
 *
 * Deliberately not a failure. The work may be entirely correct, and rejecting
 * good work for being broad would be its own bug — but a task that took eight
 * files was not atomic, and that is worth knowing before the queue fills up
 * with more like it.
 */
function noteOverflow(env: Env, task: Task, files: string[]): void {
	if (env.config.atomic.on_overflow === "off") return;
	if (files.length <= env.config.atomic.max_files) return;
	markOverflow(task, `touched ${files.length} files (budget ${env.config.atomic.max_files})`);
}

const USAGE = `todo — autonomous todo loop for pi

  todo init                      Write ${DEFAULT_CONFIG_FILE} and ${DEFAULT_STORE_FILE} starters
  todo doctor [--probe]          Check models, VRAM, git and queue shape
  todo status [--all]            Show the queue (--all includes archived work)
  todo stop                      Stop a running loop after the current task
  todo next [--id]               Print the next task's prompt (exit 3 when empty)
  todo start                     Claim the next task and print its prompt
  todo add <id> <title...>       Append a task (--detail "...", --parent <id>, --level task|scope|epic,
                                 --category <c>, --urgency <u> where the schema has them)
  todo done <id> [summary...]    Mark done without verifying
  todo block <id> <reason...>    Mark blocked
  todo reset <id>                Return a task to todo and clear attempts
  todo verify [id]               Gather evidence and print the verdict as JSON
  todo complete <id> [summary]   Verify, then mark done or record the failure
  todo checkpoint [message...]   Commit everything in the working tree
  todo run [--max N] [--dry-run] Drive the queue with one pi process per task

Shared flags: --cwd <dir> --file <todo.toml> --config <todoloop.toml>
              --provider <name> --model <id>   override the configured worker

With no --file, an existing TODO.toml or todo.toml in --cwd is adopted, and its
schema is read from the file rather than assumed. \`todo status\` names the files
it is working on.`;

function commandInit(env: Env, flags: Flags): number {
	const configPath = path.join(env.cwd, DEFAULT_CONFIG_FILE);
	const template = path.join(import.meta.dirname, "..", "templates");
	if (!fs.existsSync(configPath) || bool(flags, "force")) {
		fs.copyFileSync(path.join(template, "todoloop.toml"), configPath);
		console.log(`wrote ${configPath}`);
	} else {
		console.log(`kept existing ${configPath}`);
	}
	if (!fs.existsSync(env.storeFile) || bool(flags, "force")) {
		fs.copyFileSync(path.join(template, "todo.toml"), env.storeFile);
		console.log(`wrote ${env.storeFile}`);
	} else {
		console.log(`kept existing ${env.storeFile}`);
	}
	return EXIT_OK;
}

async function commandDoctor(env: Env, flags: Flags): Promise<number> {
	const checks = await diagnose({
		cwd: env.cwd,
		config: env.config,
		store: env.store,
		storeFile: env.storeFile,
		probe: bool(flags, "probe"),
	});
	console.log(formatChecks(checks));
	const failures = checks.filter((check) => check.level === "fail").length;
	if (failures) console.error(`\n${failures} blocking problem${failures === 1 ? "" : "s"}.`);
	return failures ? EXIT_ERROR : EXIT_OK;
}

/**
 * Which files this queue is spread over.
 *
 * Worth printing every time rather than on request: the failure this heads off
 * is the loop quietly adopting the wrong file — a fresh `todo.toml` beside the
 * real `TODO.toml` — and reporting an empty queue with complete confidence.
 */
function queueLine(env: Env): string {
	const shown = (file?: string): string => (file ? path.relative(env.cwd, file) || file : "");
	const parts = [`${shown(env.storeFile)} (${env.store.schema.name} schema)`];
	if (env.store.archive?.file) parts.push(`archive ${shown(env.store.archive.file)}`);
	if (env.store.sidecarFile) parts.push(`state ${shown(env.store.sidecarFile)}`);
	return `queue: ${parts.join(" · ")}`;
}

function commandStatus(env: Env, flags: Flags): number {
	const stats = counts(env.store);
	const tree = renderTree(env.store, { all: bool(flags, "all") });
	const waiting = blockedLeaves(env.store);
	console.log(tree || "(no tasks)");
	console.log(
		`\n${stats.done} done · ${stats.todo} todo · ${stats.doing} in progress · ${stats.blocked} blocked` +
			(waiting.length ? ` · ${waiting.length} waiting on dependencies` : "") +
			(stats.pending_breakdowns ? ` · ${stats.pending_breakdowns} awaiting breakdown` : "") +
			`\n${queueLine(env)}` +
			`\nloop: ${env.store.loop.running ? "running" : "stopped"}` +
			(env.store.loop.current ? ` · current ${env.store.loop.current}` : "") +
			` · iteration ${env.store.loop.iterations}`,
	);
	if (env.store.loop.last_failure) console.log(`last failure: ${env.store.loop.last_failure}`);
	// The distinction worth drawing loudly: a queue with nothing runnable is
	// either finished or stuck, and those call for opposite responses.
	if (waiting.length && !nextLeaf(env.store)) {
		console.log(
			`\nnothing is runnable, but ${waiting.length} task(s) are only waiting on dependencies — the queue is stuck, not done.`,
		);
	}
	return EXIT_OK;
}

/** The driver re-reads todo.toml every iteration, so this stops it between tasks. */
function commandStop(env: Env): number {
	env.store.loop.running = false;
	saveStore(env.storeFile, env.store);
	console.log("loop will stop after the current task");
	return EXIT_OK;
}

function commandNext(env: Env, flags: Flags): number {
	const task = nextLeaf(env.store);
	if (!task) return EXIT_EMPTY;
	if (bool(flags, "id")) {
		console.log(task.id);
		return EXIT_OK;
	}
	console.log(
		renderAssignmentPrompt(env.store, task, {
			mode: "standalone",
			lastFailure: env.store.loop.last_failure,
			rejections: task.rejections,
			attempts: task.attempts,
			maxAttempts: env.config.verify.max_attempts,
			maxFiles: env.config.atomic.max_files,
			minChildren: env.config.decompose.min_children,
		}),
	);
	return EXIT_OK;
}

async function commandStart(env: Env, flags: Flags): Promise<number> {
	const task = nextLeaf(env.store);
	if (!task) return EXIT_EMPTY;
	markDoing(env.store, task, await headCommit(env.cwd));
	saveStore(env.storeFile, env.store);
	return commandNext(env, flags);
}

function commandAdd(env: Env, flags: Flags): number {
	const [id, ...titleParts] = flags.positional;
	if (!id || titleParts.length === 0) {
		console.error("usage: todo add <id> <title...>");
		return EXIT_ERROR;
	}
	if (findTask(env.store, id)) {
		console.error(`task ${id} already exists`);
		return EXIT_ERROR;
	}
	const levelRaw = str(flags, "level", "task").trim().toLowerCase();
	if (levelRaw !== "task" && levelRaw !== "scope" && levelRaw !== "epic") {
		console.error(`--level must be task, scope or epic (got ${levelRaw})`);
		return EXIT_ERROR;
	}

	const task = createTask(env.store, {
		id,
		title: titleParts.join(" "),
		detail: str(flags, "detail") || undefined,
		level: levelRaw !== "task" ? levelRaw : undefined,
		category: str(flags, "category") || undefined,
		urgency: str(flags, "urgency") || undefined,
	});

	const parent = str(flags, "parent");
	if (parent) {
		const owner = findTask(env.store, parent);
		if (!owner) {
			console.error(`no such parent: ${parent}`);
			return EXIT_ERROR;
		}
		// An item gaining a child becomes a container, so naming a parent is enough
		// — no need to declare its level first. Only an explicit `level = "task"`
		// is refused, because that is a contradiction someone wrote on purpose.
		const allowed = allowedChildLevels(effectiveLevel(owner, env.store.tasks));
		if (owner.level === "task") {
			console.error(`${parent} is declared a task and cannot own children; make it a scope or an epic first`);
			return EXIT_ERROR;
		}
		if (allowed.length && !allowed.includes(levelRaw)) {
			console.error(
				`a ${effectiveLevel(owner, env.store.tasks)} may only spawn ${allowed.join(" or ")} (got ${levelRaw})`,
			);
			return EXIT_ERROR;
		}
		task.parent = parent;
		// Order is priority order, so children belong beside their parent rather
		// than behind every unrelated epic already in the queue.
		insertChildren(env.store, parent, [task]);
	} else {
		env.store.tasks.push(task);
	}

	rollup(env.store);
	saveStore(env.storeFile, env.store);
	console.log(`added ${id}${parent ? ` under ${parent}` : ""}${levelRaw !== "task" ? ` [${levelRaw}]` : ""}`);
	return EXIT_OK;
}

function commandDone(env: Env, flags: Flags): number {
	const [id, ...summary] = flags.positional;
	const task = id ? findTask(env.store, id) : undefined;
	if (!task) {
		console.error(`no such task: ${id ?? "(missing id)"}`);
		return EXIT_ERROR;
	}
	markDone(env.store, task, summary.join(" ") || "Marked done manually.");
	saveStore(env.storeFile, env.store);
	console.log(`${id} done`);
	return EXIT_OK;
}

function commandBlock(env: Env, flags: Flags): number {
	const [id, ...reason] = flags.positional;
	const task = id ? findTask(env.store, id) : undefined;
	if (!task) {
		console.error(`no such task: ${id ?? "(missing id)"}`);
		return EXIT_ERROR;
	}
	markBlocked(env.store, task, reason.join(" ") || "Blocked manually.");
	saveStore(env.storeFile, env.store);
	console.log(`${id} blocked`);
	return EXIT_OK;
}

function commandReset(env: Env, flags: Flags): number {
	const [id] = flags.positional;
	const task = id ? findTask(env.store, id) : undefined;
	if (!task) {
		console.error(`no such task: ${id ?? "(missing id)"}`);
		return EXIT_ERROR;
	}
	task.status = "todo";
	task.attempts = 0;
	task.reason = undefined;
	task.done_at = undefined;
	task.summary = undefined;
	// "Clear attempts" has to mean the history too, or a reset task carries three
	// rejections into a prompt that says it is on attempt one.
	task.rejections = undefined;
	env.store.loop.last_failure = "";
	saveStore(env.storeFile, env.store);
	console.log(`${id} reset`);
	return EXIT_OK;
}

async function commandVerify(env: Env, flags: Flags): Promise<number> {
	const id = flags.positional[0] ?? env.store.loop.current;
	const task = id ? findTask(env.store, id) : nextLeaf(env.store);
	if (!task) {
		console.error("no task to verify");
		return EXIT_ERROR;
	}
	const verdict = await verifyTask(env, task);
	console.log(JSON.stringify(verdict, null, 2));
	return verdict.pass ? EXIT_OK : EXIT_REJECTED;
}

async function commandComplete(env: Env, flags: Flags): Promise<number> {
	const [maybeId, ...summaryParts] = flags.positional;
	const id = maybeId ?? env.store.loop.current;
	const task = id ? findTask(env.store, id) : undefined;
	if (!task) {
		console.error(`no such task: ${id ?? "(missing id)"}`);
		return EXIT_ERROR;
	}

	const verdict = await verifyTask(env, task);
	if (verdict.pass) {
		markDone(env.store, task, summaryParts.join(" ") || "Verified complete.");
		saveStore(env.storeFile, env.store);
		await checkpoint(env, task, summaryParts.join(" ") || verdict.reason);
		console.log(`${task.id} verified and closed`);
		return EXIT_OK;
	}

	const attempts = recordFailure(env.store, task, verdict.reason);
	if (attempts >= env.config.verify.max_attempts) {
		markBlocked(env.store, task, `Blocked after ${attempts} attempts: ${verdict.reason}`);
		saveStore(env.storeFile, env.store);
		console.error(`${task.id} blocked after ${attempts} attempts: ${verdict.reason}`);
		return EXIT_ERROR;
	}
	saveStore(env.storeFile, env.store);
	console.error(`${task.id} rejected (attempt ${attempts}): ${verdict.reason}`);
	return EXIT_REJECTED;
}

/** Subject stays short and scannable; the verdict, which can run to a paragraph, goes in the body. */
async function checkpoint(env: Env, task: Task, body: string): Promise<void> {
	// A strictness ladder: "off" commits nothing, "commit" commits, and
	// "require-clean" commits *and* refuses to start dirty. Anything but "off"
	// therefore commits here.
	if (env.config.loop.checkpoint === "off") return;
	if (!(await isGitRepo(env.cwd))) return;
	const subject = `${env.config.loop.commit_prefix}(${task.id}): ${task.title}`;
	const message = body.trim() ? `${subject}\n\n${body.trim()}` : subject;
	if (await commitAll(env.cwd, message)) console.log(`committed: ${subject}`);
}

async function commandCheckpoint(env: Env, flags: Flags): Promise<number> {
	const message = flags.positional.join(" ") || "todo-loop checkpoint";
	if (!(await isGitRepo(env.cwd))) {
		console.error("not a git repository");
		return EXIT_ERROR;
	}
	console.log((await commitAll(env.cwd, message)) ? `committed: ${message}` : "nothing to commit");
	return EXIT_OK;
}

/** A worker that cannot do the task as written says so rather than guessing. */
export function findBlockMarker(output: string): string | undefined {
	const matches = [...output.matchAll(/^\s*(?:\*\*)?BLOCKED(?:\*\*)?:\s*(.+)$/gim)];
	const last = matches.at(-1);
	return last ? last[1].trim() : undefined;
}

interface PiRun {
	code: number;
	output: string;
}

/**
 * The pi invocation for one task, and a label for the model it will use.
 *
 * The label exists so a dry run says which model the real run would pick.
 * Getting that wrong is otherwise invisible until the tokens are spent.
 */
export function workerArgs(config: Config, prompt: string): { args: string[]; model: string } {
	// pi reads a trailing `:suffix` on --model as a thinking level, so an ollama
	// tag like `qwen3.8-27b:52k` cannot round-trip through the flag. Inheriting
	// pi's own default is the way out when that bites.
	if (inheritsWorker(config)) return { args: ["-p", "--", prompt], model: "inherited from pi" };
	const { provider, model } = splitModelRef(config.models.worker);
	return {
		args: ["-p", "--provider", provider, "--model", model, "--", prompt],
		model: `${provider}/${model}`,
	};
}

function runPi(env: Env, prompt: string, dryRun: boolean): Promise<PiRun> {
	const { args, model } = workerArgs(env.config, prompt);
	if (dryRun) {
		console.log(`--- would run pi (${model}) with prompt ---\n${prompt}\n--- end prompt ---`);
		return Promise.resolve({ code: 0, output: "" });
	}
	return new Promise((resolve) => {
		// stdin must be closed: pi's print mode waits for EOF before it runs the
		// prompt, so an inherited pipe makes it hang with the model loaded and idle.
		// stdout is piped so the run can be read for a BLOCKED marker, and echoed
		// so it still streams.
		const child = spawn("pi", args, { cwd: env.cwd, stdio: ["ignore", "pipe", "inherit"] });
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			process.stdout.write(chunk);
		});
		child.on("error", (error) => {
			console.error(`failed to launch pi: ${error.message}`);
			resolve({ code: 127, output });
		});
		child.on("close", (code) => resolve({ code: code ?? EXIT_ERROR, output }));
	});
}

async function commandRun(env: Env, flags: Flags): Promise<number> {
	const dryRun = bool(flags, "dry-run");
	const maxIterations = Number(str(flags, "max", String(env.config.loop.max_iterations))) || 1;

	// A dry run walks the queue in memory and writes nothing. Marking every task
	// done — or committing whatever happens to be in the tree — is not what
	// "print the prompts instead of calling a model" should mean.
	const persist = (): void => {
		if (!dryRun) saveStore(env.storeFile, env.store);
	};
	const refresh = (): void => {
		if (!dryRun) env.store = loadStore(env.storeFile);
	};

	env.store.loop.running = true;
	env.store.loop.iterations = 0;
	persist();

	for (let iteration = 1; iteration <= maxIterations; iteration++) {
		refresh();
		if (!env.store.loop.running) {
			console.log("loop stopped");
			return EXIT_OK;
		}

		const task = nextLeaf(env.store);
		if (!task) {
			env.store.loop.running = false;
			persist();
			console.log(`queue empty after ${iteration - 1} iterations`);
			return EXIT_OK;
		}

		if (env.config.loop.checkpoint === "require-clean" && !(await isTreeClean(env.cwd, queueExcludes(env)))) {
			console.error("working tree is dirty and checkpoint = require-clean; refusing to start a task");
			env.store.loop.running = false;
			persist();
			return EXIT_ERROR;
		}

		markDoing(env.store, task, await headCommit(env.cwd));
		env.store.loop.iterations = iteration;
		persist();

		const prompt = renderAssignmentPrompt(env.store, task, {
			mode: "standalone",
			lastFailure: env.store.loop.last_failure,
			rejections: task.rejections,
			attempts: task.attempts,
			maxAttempts: env.config.verify.max_attempts,
			maxFiles: env.config.atomic.max_files,
			minChildren: env.config.decompose.min_children,
		});

		const kind = assignmentFor(task) === "decompose" ? `break down ${levelOf(task)}` : "implement";
		console.log(`\n=== [${iteration}/${maxIterations}] ${kind} — ${task.id}: ${task.title} ===`);
		const result = await runPi(env, prompt, dryRun);
		if (result.code !== 0) console.error(`pi exited ${result.code}; verifying anyway`);

		refresh();
		const current = findTask(env.store, task.id);
		if (!current) continue;

		// A declared blocker is a claim about the task, not the diff, so it is
		// taken at face value rather than sent to the verifier.
		const blocker = findBlockMarker(result.output);
		if (blocker) {
			markBlocked(env.store, current, blocker);
			persist();
			console.error(`⊘ ${current.id} blocked by the worker: ${blocker}`);
			return EXIT_ERROR;
		}

		const verdict = dryRun ? { pass: true, reason: "dry run" } : await verifyTask(env, current);
		if (verdict.pass) {
			markDone(env.store, current, verdict.reason);
			persist();
			if (!dryRun) await checkpoint(env, current, current.summary ?? "");

			console.log(`✓ ${current.id} verified`);
			continue;
		}

		const attempts = recordFailure(env.store, current, verdict.reason);
		console.error(`✗ ${current.id} rejected (attempt ${attempts}/${env.config.verify.max_attempts}): ${verdict.reason}`);

		// A task that both overran its context budget and failed verification is
		// far more likely to be too big than to be nearly right. Retrying the same
		// oversized prompt two more times just spends tokens confirming that.
		if (
			env.config.atomic.on_overflow === "promote" &&
			current.overflowed &&
			levelOf(current) === "task" &&
			assignmentFor(current) === "implement"
		) {
			promoteToScope(env.store, current, `Promoted to scope: ${current.overflow_reason ?? "over budget"}`);
			persist();
			console.error(`↑ ${current.id} promoted to scope — ${current.overflow_reason}; it will be broken down next`);
			continue;
		}

		if (attempts >= env.config.verify.max_attempts) {
			markBlocked(env.store, current, `Blocked after ${attempts} attempts: ${verdict.reason}`);
			persist();
			console.error("halting: a task the worker cannot finish should not become an unbounded token burn");
			return EXIT_ERROR;
		}
		persist();
	}

	refresh();
	env.store.loop.running = false;
	persist();
	console.error(`stopped after the ${maxIterations}-iteration cap`);
	return EXIT_ERROR;
}

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") {
		console.log(USAGE);
		return EXIT_OK;
	}

	const flags = parseArgs(rest);
	const env = loadEnv(flags);

	switch (command) {
		case "init":
			return commandInit(env, flags);
		case "status":
			return commandStatus(env, flags);
		case "doctor":
			return commandDoctor(env, flags);
		case "stop":
			return commandStop(env);
		case "next":
			return commandNext(env, flags);
		case "start":
			return commandStart(env, flags);
		case "add":
			return commandAdd(env, flags);
		case "done":
			return commandDone(env, flags);
		case "block":
			return commandBlock(env, flags);
		case "reset":
			return commandReset(env, flags);
		case "verify":
			return commandVerify(env, flags);
		case "complete":
			return commandComplete(env, flags);
		case "checkpoint":
			return commandCheckpoint(env, flags);
		case "run":
			return commandRun(env, flags);
		default:
			console.error(`unknown command: ${command}\n\n${USAGE}`);
			return EXIT_ERROR;
	}
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: Error) => {
			console.error(error.message);
			process.exitCode = EXIT_ERROR;
		});
}
