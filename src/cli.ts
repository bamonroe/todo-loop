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
import { clockTime, describePhases, formatDuration, stampConsole } from "./clock.ts";
import { describeTelemetry, emptyTelemetry, SessionMonitor, type RunTelemetry } from "./events.ts";
import { commitAll, evidenceFilePath, gatherEvidence, headCommit, isGitRepo, isTreeClean, loopOwnedPaths, revertTo, runCommand } from "./evidence.ts";
import { renderAssignmentPrompt } from "./prompt.ts";
import { maintainNotes } from "./notes.ts";
import { checkPlanRound, type PlanVerdict } from "./plan.ts";
import {
	allowedChildLevels,
	assignmentFor,
	blockedLeaves,
	counts,
	discardChildren,
	createTask,
	DEFAULT_STORE_FILE,
	effectiveLevel,
	findTask,
	insertChildren,
	levelOf,
	markOverflow,
	kindOf,
	promoteToPlan,
	researchBudgetOf,
	unfinishedChildren,
	loadStore,
	markBlocked,
	markDoing,
	markDone,
	nextReady,
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
	/**
	 * Where the worker's session records results from `verify.evidence_tools`.
	 *
	 * One path for the whole driver process, truncated before each session, so an
	 * attempt is always judged on its own tool output and never on the one that
	 * was just reverted. Outside the repository on purpose: the checkpoint commit
	 * is `git add -A`.
	 */
	evidenceFile: string;
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
	return { cwd, config, storeFile, store: loadStore(storeFile), evidenceFile: evidenceFilePath(cwd) };
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
		maxDiffBytes: env.config.verify.max_diff_bytes,
		exclude: queueExcludes(env),
		evidenceFile: env.evidenceFile,
	});
}

/**
 * A planning round is checked against the store and the diff; an act is checked
 * by a model. Both are gated on the same evidence, so this is the only place
 * that has to know which kind of work just happened.
 */
async function verifyTask(env: Env, task: Task, signal?: AbortSignal): Promise<Verdict | PlanVerdict> {
	if (assignmentFor(task) === "plan") {
		// Re-read: the worker added children through the CLI, so the in-memory
		// store is stale by exactly the rows that decide this verdict.
		env.store = loadStore(env.storeFile);
		const current = findTask(env.store, task.id) ?? task;
		const evidence = await evidenceFor(env);
		return checkPlanRound(env.store, current, evidence.files, env.config);
	}

	if (!env.config.verify.enabled) return { pass: true, reason: "Verification disabled.", mechanical: true };
	const evidence = await evidenceFor(env);
	noteOverflow(env, task, evidence.files);
	return verify(task, evidence, verifierFor(env, signal));
}

/**
 * The verdict for a planning round that ran out of clock.
 *
 * Accepted only if it actually wrote something that passes the ordinary check.
 * Two cases need care. A round that added nothing must not be read as the
 * planner saying "no next step" — that is what `finished` means, and letting a
 * timeout close a branch would end the project on a stopwatch. And a round that
 * added items but broke a rule is still a rejection, so its half-batch is
 * discarded exactly as before.
 */
async function timedOutRound(env: Env, task: Task, budgetMs: number): Promise<PlanVerdict> {
	const overran = `Worker exceeded its ${budgetMs}ms budget.`;
	const verdict = (await verifyTask(env, task)) as PlanVerdict;
	if (!verdict.pass) return { ...verdict, reason: `${verdict.reason} (${overran})` };
	if (verdict.finished) return { pass: false, mechanical: true, reason: `${overran} The round added nothing.` };
	return { ...verdict, reason: `${verdict.reason} Cut short by the ${budgetMs}ms budget, so the next round continues it.` };
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

/**
 * Flag a leaf whose worker ran out of clock.
 *
 * Overflow had two sources, and both required the worker to *finish*: a diff
 * wider than `atomic.max_files`, or compaction firing mid-task. A worker that
 * spends its whole budget and gets killed produces neither — no diff, no
 * compaction — so the task that proved it was too big was the one case nothing
 * marked, and `on_overflow = "promote"` could never see it.
 *
 * Run 10 is the evidence. Its EqScreen act timed out, came back with no file
 * changes, timed out again, and blocked the run after ninety minutes. Splitting
 * it is exactly what promotion does, and the three attempts were each trying to
 * do the split by hand and running out of time saying so.
 *
 * Unlike a wide diff this is not ambiguous. Wide work may be correct and only
 * broad; work that never finished is not correct yet by definition.
 */
export function noteBudgetOverflow(env: Env, task: Task, budgetMs: number, detail = ""): void {
	if (env.config.atomic.on_overflow === "off") return;
	// The detail is what makes the promotion reviewable. "Used its whole budget"
	// is true of a task that is too large and of one that sat in a wedged Gradle
	// call for half an hour, and those want opposite responses.
	markOverflow(task, `worker used its whole ${budgetMs}ms budget without finishing${detail ? `: ${detail}` : ""}`);
}

const USAGE = `todo — autonomous todo loop for pi

  todo init                      Write ${DEFAULT_CONFIG_FILE} and ${DEFAULT_STORE_FILE} starters
  todo doctor [--probe]          Check models, VRAM, git and queue shape
  todo status [--all]            Show the queue (--all includes archived work)
  todo stop                      Stop a running loop after the current task
  todo next [--id]               Print the next task's prompt (exit 3 when empty)
  todo start                     Claim the next task and print its prompt
  todo add <id> <title...>       Append an item (--detail "...", --parent <id>, --level act|plan,
                                --kind code|docs|research,
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
			(stats.pending_breakdowns ? ` · ${stats.pending_breakdowns} plans not yet started` : "") +
			`\n${queueLine(env)}` +
			`\nloop: ${env.store.loop.running ? "running" : "stopped"}` +
			(env.store.loop.current ? ` · current ${env.store.loop.current}` : "") +
			` · iteration ${env.store.loop.iterations}`,
	);
	if (env.store.loop.last_failure) console.log(`last failure: ${env.store.loop.last_failure}`);
	// The distinction worth drawing loudly: a queue with nothing runnable is
	// either finished or stuck, and those call for opposite responses.
	if (waiting.length && !nextReady(env.store)) {
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
	const task = nextReady(env.store);
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
			maxChildren: env.config.plan.max_children,
			researchBudget: researchBudgetOf(task, env.config.plan.research_budget),
			lookBudget: env.config.plan.look_budget,
			maxDepth: env.config.plan.max_depth,
			memoryFile: env.config.plan.memory_file,
			buildCommand: env.config.verify.build_command,
			workerCheck: env.config.verify.worker_check,
			workerTools: env.config.project.worker_tools,
			interruptedThinking: task.interrupted_thinking,
			carriedWork: env.store.loop.carried === task.id,
			testCommand: env.config.verify.test_command,
		}),
	);
	return EXIT_OK;
}

async function commandStart(env: Env, flags: Flags): Promise<number> {
	const task = nextReady(env.store);
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
	const levelRaw = str(flags, "level", "act").trim().toLowerCase();
	if (levelRaw !== "act" && levelRaw !== "plan") {
		console.error(`--level must be act or plan (got ${levelRaw})`);
		return EXIT_ERROR;
	}
	const kindRaw = str(flags, "kind", "code").trim().toLowerCase();
	if (kindRaw !== "code" && kindRaw !== "docs" && kindRaw !== "research") {
		console.error(`--kind must be code, docs or research (got ${kindRaw})`);
		return EXIT_ERROR;
	}

	const task = createTask(env.store, {
		id,
		title: titleParts.join(" "),
		detail: str(flags, "detail") || undefined,
		level: levelRaw === "plan" ? "plan" : undefined,
		kind: levelRaw === "act" ? kindRaw : undefined,
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
		if (owner.level === "act") {
			console.error(`${parent} is declared an act and cannot own children; make it a plan first`);
			return EXIT_ERROR;
		}
		if (allowed.length && !allowed.includes(levelRaw)) {
			console.error(`a ${effectiveLevel(owner, env.store.tasks)} may only spawn ${allowed.join(" or ")} (got ${levelRaw})`);
			return EXIT_ERROR;
		}
		// The allowance is inherited, never refreshed: a planner that has spent its
		// research rounds cannot get more by spawning a sub-planner to keep reading.
		if (levelRaw === "plan") {
			task.research_budget = researchBudgetOf(owner, env.config.plan.research_budget);
		}
		task.parent = parent;
		// Order is priority order, so children belong beside their parent rather
		// than behind every unrelated plan already in the queue.
		insertChildren(env.store, parent, [task]);
	} else {
		env.store.tasks.push(task);
	}

	rollup(env.store);
	saveStore(env.storeFile, env.store);
	console.log(`added ${id}${parent ? ` under ${parent}` : ""} [${levelRaw === "plan" ? "plan" : kindRaw}]`);
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
	const task = id ? findTask(env.store, id) : nextReady(env.store);
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
/** What to do with the working tree of an attempt that did not pass. */
export type TreeDisposition = "carry" | "preserve" | "revert";

/**
 * A verifier rejection and a timeout are not the same event, and the tree they
 * leave behind should not be treated the same way.
 *
 * A rejection is a judgement that the work is wrong; building the retry on top
 * of it builds on a mistake, so it goes. A timeout is a judgement about nothing
 * — the model was still typing — and run 13 proved what discarding it costs:
 * iterations 12 and 13 were killed while BandSliders.kt was written and
 * compiling, `git reset --hard` deleted it, and the next attempt paid to write
 * it again from nothing.
 *
 * "preserve" is the same decision one attempt later. On the last attempt there
 * is no retry to carry the tree into, but reverting would still throw away
 * every attempt's work at the moment a human is about to be handed the problem;
 * committing it keeps both the work and a clean tree, which is what a promoted
 * plan needs — its round is rejected if the diff is not empty.
 *
 * A planning round is excluded throughout: its output is queue entries, not
 * files, and a truncated round's items are judged on their own terms.
 */
export function treeDisposition(options: {
	timedOut: boolean;
	planning: boolean;
	attempts: number;
	maxAttempts: number;
}): TreeDisposition {
	if (!options.timedOut || options.planning) return "revert";
	return options.attempts < options.maxAttempts ? "carry" : "preserve";
}

export function findBlockMarker(output: string): string | undefined {
	const matches = [...output.matchAll(/^\s*(?:\*\*)?BLOCKED(?:\*\*)?:\s*(.+)$/gim)];
	const last = matches.at(-1);
	return last ? last[1].trim() : undefined;
}

interface PiRun {
	code: number;
	/** What the worker said, assembled from its assistant messages. */
	output: string;
	/** The worker was killed for overrunning loop.worker_timeout_ms. */
	timedOut?: boolean;
	/**
	 * The reasoning of the message that was still being generated at the kill.
	 *
	 * Captured from the live event stream rather than the session file, because
	 * a message that never ends never gets written to one. Empty for a worker
	 * that exited normally — there is nothing there worth carrying.
	 */
	thinking?: string;
	/** What the session did, for the log and for the reason a rejection carries. */
	telemetry: RunTelemetry;
}

/**
 * The pi invocation for one task, and a label for the model it will use.
 *
 * The label exists so a dry run says which model the real run would pick.
 * Getting that wrong is otherwise invisible until the tokens are spent.
 *
 * `--approve` is what makes the project's own `.pi/settings.json` load at all.
 * pi only asks about project trust interactively, and print mode never asks, so
 * without the flag it falls back to `defaultProjectTrust` — `ask` by default,
 * which *silently* skips the file. That matters most for a small local window,
 * where `reserveTokens` and `keepRecentTokens` have to be resized or compaction
 * can retain more than its own trigger threshold and fire forever. pi parses
 * the file either way and will warn about bad JSON in it, so a clean start is
 * not evidence the settings applied. Verified on pi 0.85.1: `pi -p` reported
 * the global thinking level, `pi -p --approve` the project's.
 *
 * The trust this grants is project-local files in a repo the loop is already
 * running the test and build commands from, so it widens nothing that the
 * checkpoint and verify config had not already conceded.
 *
 * `--mode json` turns stdout into one event per line instead of the handful of
 * lines text mode prints. The driver was blind without it: it could see that a
 * worker had overrun its budget but not what it had been doing, which is the
 * one question ten killed sessions in run 13 all raised. See src/events.ts.
 */
export function workerArgs(config: Config, prompt: string): { args: string[]; model: string } {
	// [project].packages replaces pi's global extension discovery with exactly
	// this project's tools: --no-extensions turns discovery off, and explicit -e
	// paths still load. Order matters to nobody but the reader; the flags go
	// before "--" because everything after it is the prompt.
	const packages = config.project.packages.flatMap((entry) => ["-e", entry]);
	const isolation = packages.length ? ["--no-extensions", ...packages] : [];
	// pi reads a trailing `:suffix` on --model as a thinking level, so an ollama
	// tag like `qwen3.8-27b:52k` cannot round-trip through the flag. Inheriting
	// pi's own default is the way out when that bites.
	const base = ["-p", "--approve", "--mode", "json"];
	if (inheritsWorker(config)) return { args: [...base, ...isolation, "--", prompt], model: "inherited from pi" };
	const { provider, model } = splitModelRef(config.models.worker);
	return {
		args: [...base, "--provider", provider, "--model", model, ...isolation, "--", prompt],
		model: `${provider}/${model}`,
	};
}

function runPi(env: Env, prompt: string, dryRun: boolean, budgetMs = 0): Promise<PiRun> {
	const { args, model } = workerArgs(env.config, prompt);
	if (dryRun) {
		console.log(`--- would run pi (${model}) with prompt ---\n${prompt}\n--- end prompt ---`);
		return Promise.resolve({ code: 0, output: "", telemetry: emptyTelemetry() });
	}
	return new Promise((resolve) => {
		// stdin must be closed: pi's print mode waits for EOF before it runs the
		// prompt, so an inherited pipe makes it hang with the model loaded and idle.
		// stdout is piped so the event stream can be read, and rendered back out
		// a line at a time so the run still streams to whoever is watching.
		// Tell the extension which side of the loop it is on. Both read the same
		// `loop.running` flag, so without this the session drives the loop too:
		// every task verified and committed twice, then a failed attempt to
		// replace a print mode session.
		const budget = budgetMs;
		// Start every session with an empty evidence file. Without the truncate a
		// rejected attempt's install output would still be sitting there when the
		// retry is judged, and the retry would be credited with work it did not do.
		try {
			fs.writeFileSync(env.evidenceFile, "");
		} catch {
			// Nothing to record into is the same as a worker that called no tools.
		}
		const child = spawn("pi", args, {
			cwd: env.cwd,
			stdio: ["ignore", "pipe", "inherit"],
			env: { ...process.env, TODOLOOP_DRIVER: "shell", TODOLOOP_EVIDENCE_FILE: env.evidenceFile },
		});
		const monitor = new SessionMonitor({ onLine: (line) => process.stdout.write(`${line}\n`) });
		// setEncoding, not chunk.toString(): a chunk boundary can fall inside a
		// multi-byte character, and half a character in the middle of a JSON line
		// is an event silently lost.
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => monitor.feed(chunk));
		child.on("error", (error) => {
			console.error(`failed to launch pi: ${error.message}`);
			resolve({ code: 127, output: monitor.text, telemetry: monitor.telemetry });
		});
		// Kill an overrunning worker rather than letting one lost session spend the
		// night. SIGTERM first so pi can wind down; SIGKILL if it will not.
		let timedOut = false;
		const timer = budget
			? setTimeout(() => {
					timedOut = true;
					// Read the telemetry *before* the kill, while the stuck tool is
					// still stuck: this is the moment the question "doing what?" has an
					// answer, and it is gone a second later.
					const doing = describeTelemetry(monitor.telemetry);
					console.error(`worker exceeded its ${budget}ms budget; stopping it${doing ? ` — ${doing}` : ""}`);
					child.kill("SIGTERM");
					setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
				}, budget)
			: undefined;

		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			monitor.end();
			// Reported as a failure, not as output: a half-written session that got
			// cut off must not reach the verifier looking like finished work.
			resolve({
				code: timedOut ? EXIT_ERROR : (code ?? EXIT_ERROR),
				output: monitor.text,
				timedOut,
				// Only from a kill. After a clean exit the monitor's buffer is
				// empty anyway, because the last message ended; reading it here
				// keeps that a fact about the data rather than a coincidence.
				thinking: timedOut ? monitor.thinking : "",
				telemetry: monitor.telemetry,
			});
		});
	});
}

async function commandRun(env: Env, flags: Flags): Promise<number> {
	const dryRun = bool(flags, "dry-run");
	const maxIterations = Number(str(flags, "max", String(env.config.loop.max_iterations))) || 1;
	// Every line from here to teardown carries the time it was written. The
	// gaps between the worker's own tool lines are what say where a session
	// went, and until now nothing in the log could be subtracted from anything.
	const unstamp = stampConsole();
	try {
		return await timedRun(env, flags, dryRun, maxIterations);
	} finally {
		unstamp();
	}
}

async function timedRun(env: Env, flags: Flags, dryRun: boolean, maxIterations: number): Promise<number> {
	const runStarted = Date.now();

	// A dry run walks the queue in memory and writes nothing. Marking every task
	// done — or committing whatever happens to be in the tree — is not what
	// "print the prompts instead of calling a model" should mean.
	const persist = (): void => {
		if (!dryRun) saveStore(env.storeFile, env.store);
	};
	const refresh = (): void => {
		if (!dryRun) env.store = loadStore(env.storeFile);
	};

	// [project].setup_command: infrastructure the workers should find already
	// present — an emulator booted, a container warmed — paid for once here
	// instead of once per session by a model that cannot afford it. Failing to
	// set up is failing the run: every task after it would inherit the gap.
	if (!dryRun && env.config.project.setup_command) {
		const setup = await runCommand(env.cwd, env.config.project.setup_command, 0, 16 * 1024);
		if (!setup.ok) {
			console.error(`setup_command failed (exit ${setup.code}):\n${setup.output}`);
			return EXIT_ERROR;
		}
		console.log(`[todo-loop] setup: ${env.config.project.setup_command}`);
	}

	env.store.loop.running = true;
	env.store.loop.iterations = 0;
	persist();

	try {
		return await runLoop(env, flags, dryRun, maxIterations, persist, refresh);
	} finally {
		console.log(`[todo-loop] run finished after ${formatDuration(Date.now() - runStarted)} (started ${clockTime(runStarted)})`);
		// Teardown runs on every exit — clean, error, or thrown — and its own
		// failure is only reported. The kill-the-driver habit means orphaned
		// infrastructure is the common case, not the odd one.
		if (!dryRun && env.config.project.teardown_command) {
			const teardown = await runCommand(env.cwd, env.config.project.teardown_command, 0, 16 * 1024);
			if (!teardown.ok) console.error(`teardown_command failed (exit ${teardown.code}), continuing:\n${teardown.output}`);
		}
	}
}

async function runLoop(
	env: Env,
	flags: Flags,
	dryRun: boolean,
	maxIterations: number,
	persist: () => void,
	refresh: () => void,
): Promise<number> {
	for (let iteration = 1; iteration <= maxIterations; iteration++) {
		refresh();
		if (!env.store.loop.running) {
			console.log("loop stopped");
			return EXIT_OK;
		}

		// The notes tripwire: at most one maintenance act, queued before picking
		// so it competes for the next slot like any other work.
		if (!dryRun) {
			const queued = maintainNotes(
				env.store,
				env.cwd,
				env.config.plan.memory_file,
				env.config.plan.memory_share,
				env.config.plan.memory_window_tokens,
			);
			if (queued) {
				console.log(`[todo-loop] notes maintenance queued: ${queued.id} — ${queued.title}`);
				persist();
			}
		}

		const task = nextReady(env.store);
		if (!task) {
			env.store.loop.running = false;
			persist();
			console.log(`queue empty after ${iteration - 1} iterations`);
			return EXIT_OK;
		}

		// The gate exists to stop one task's leftovers being committed under the
		// next task's name. A tree the loop itself chose to keep, for the very
		// task about to run again, is not that: it is the retry's own unfinished
		// work, and refusing to start on it would turn the carry into a halt.
		const carried = env.store.loop.carried === task.id;
		if (env.config.loop.checkpoint === "require-clean" && !carried && !(await isTreeClean(env.cwd, queueExcludes(env)))) {
			console.error("working tree is dirty and checkpoint = require-clean; refusing to start a task");
			env.store.loop.running = false;
			persist();
			return EXIT_ERROR;
		}
		if (carried) console.error(`  carrying forward ${task.id}'s unfinished work from the previous attempt`);

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
			maxChildren: env.config.plan.max_children,
			researchBudget: researchBudgetOf(task, env.config.plan.research_budget),
			lookBudget: env.config.plan.look_budget,
			maxDepth: env.config.plan.max_depth,
			memoryFile: env.config.plan.memory_file,
			buildCommand: env.config.verify.build_command,
			workerCheck: env.config.verify.worker_check,
			workerTools: env.config.project.worker_tools,
			interruptedThinking: task.interrupted_thinking,
			carriedWork: env.store.loop.carried === task.id,
			testCommand: env.config.verify.test_command,
		});

		const planning = assignmentFor(task) === "plan";
		const kind = planning ? "plan next steps for" : `${kindOf(task)}`;
		console.log(`\n=== [${iteration}/${maxIterations}] ${kind} — ${task.id}: ${task.title} ===`);
		const budgetMs = planning ? env.config.loop.plan_timeout_ms : env.config.loop.worker_timeout_ms;
		// Three clocks, because "the iteration took 31 minutes" is not an
		// actionable sentence. The worker's share is the one a bigger budget or
		// a faster model moves; the verifier's is a network call that a local
		// model would trade for VRAM; the rest is the build and the tests.
		const attemptStarted = Date.now();
		const result = await runPi(env, prompt, dryRun, budgetMs);
		const workerMs = Date.now() - attemptStarted;
		// Printed on every session, not only the ones that overran. A run's
		// budget overruns are only legible against what an ordinary session
		// costs, and run 13 recorded neither.
		const cost = describeTelemetry(result.telemetry);
		if (cost) console.log(`[todo-loop] session: ${cost}`);
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

		// A cut-off *act* is judged on the clock, not on its diff. Sending
		// half-finished work to the verifier wastes a verification to be told what
		// we already know, and a lucky pass would commit it.
		//
		// A cut-off *planning round* is judged on what it landed. Its check is
		// mechanical — no model, nothing leaving the machine — and under
		// re-entrancy a short round is not a broken one: the plan is asked again
		// with what landed in front of it, which is the whole design. Discarding
		// three well-ordered items to retry from zero under identical conditions
		// is how run 5 turned a productive round into a failed one.
		const verdict = dryRun
			? { pass: true, reason: "dry run", finished: true }
			: !result.timedOut
				? await verifyTask(env, current)
				: planning
					? await timedOutRound(env, current, budgetMs)
					: { pass: false, reason: `Worker exceeded its ${budgetMs}ms budget${cost ? ` (${cost})` : ""}.` };
		// A timed-out act never reaches a verifier, so it has no verify phase to
		// report — undefined rather than a misleading zero.
		const verifyMs = result.timedOut && !planning ? undefined : Date.now() - attemptStarted - workerMs;
		const timing = `${formatDuration(Date.now() - attemptStarted)} (${describePhases([
			["worker", workerMs],
			["verify", verifyMs],
		])})`;
		// A planning round's check reloads the store to see the rows the worker
		// wrote, so anything held across that call now points at a discarded copy
		// of the queue. Re-find before mutating: every write from here down —
		// status, attempts, the research balance, the failure record — would
		// otherwise land on an orphan and be dropped by persist(). Accepting a
		// round left the plan `doing` forever, ending re-entrancy on its first
		// success; rejecting one never incremented attempts, so max_attempts
		// never tripped and the same round was retried to the iteration cap.
		const live = findTask(env.store, task.id) ?? current;

		if (verdict.pass) {
			const plan = planning ? (verdict as PlanVerdict) : undefined;
			if (plan?.spentResearch) {
				// Charged on the round that used it, not on the act itself: the
				// allowance is about how a *branch* is allowed to make progress.
				live.research_budget = Math.max(0, researchBudgetOf(live, env.config.plan.research_budget) - 1);
			}
			// A plan is not finished by a round succeeding. It goes back in the
			// queue and is asked again once this batch has landed — that revisit,
			// with the results readable on disk, is the entire point of the design.
			// Only a round that adds nothing closes it.
			if (planning && !plan?.finished) {
				live.status = "todo";
				live.attempts = 0;
				live.rejections = undefined;
				if (env.store.loop.current === live.id) env.store.loop.current = "";
				env.store.loop.last_failure = "";
				persist();
				if (!dryRun) await checkpoint(env, live, verdict.reason);
				console.log(`✓ ${live.id} planned in ${timing} — ${verdict.reason}`);
				continue;
			}

			markDone(env.store, live, verdict.reason);
			persist();
			if (!dryRun) await checkpoint(env, live, live.summary ?? "");

			console.log(`✓ ${live.id} verified in ${timing}`);
			continue;
		}

		const attempts = recordFailure(env.store, live, verdict.reason);
		console.error(`✗ ${live.id} rejected (attempt ${attempts}/${env.config.verify.max_attempts}) after ${timing}: ${verdict.reason}`);

		// A cut-off round that was *also* rejected on its merits leaves a half
		// batch that broke a rule. That is not salvage, so it goes — but only
		// here, on the rejection path: a cut-off round whose items pass the check
		// was accepted above and keeps them, because the plan will be asked again
		// with them in front of it. A round the check rejected without running out
		// of clock keeps its items too, since its retry prompt promises that.
		//
		// Under re-entrancy this must only discard what *this* round wrote. The
		// earlier rounds' children are all done — that is what made the plan ready
		// again — so the unfinished ones are exactly this round's, and dropping a
		// completed subtree would delete shipped work.
		if (result.timedOut && planning) {
			const dropped: string[] = [];
			for (const child of unfinishedChildren(live.id, env.store.tasks)) {
				dropped.push(...discardChildren(env.store, child.id));
				env.store.tasks = env.store.tasks.filter((row) => row.id !== child.id);
				dropped.push(child.id);
			}
			if (dropped.length) console.error(`  discarded ${dropped.length} item(s) from the truncated round`);
		}

		// An act that ran out of clock keeps its tree. Everything else loses it.
		//
		// The two are not the same event. A verifier rejection is a judgement that
		// the work is wrong, and starting the retry from it would build on a
		// mistake. A timeout is a judgement about nothing at all — the model was
		// still typing — and the code underneath is as likely to be right as
		// anything else the worker produced. Run 13 killed iterations 12 and 13
		// while BandSliders.kt was written and compiling; `git reset --hard`
		// deleted it, and the next attempt paid to write it again from nothing.
		//
		// Planning rounds are excluded because their edits are queue entries, not
		// files, and a truncated round's items are already handled above.
		const disposition = treeDisposition({
			timedOut: !!result.timedOut,
			planning,
			attempts,
			maxAttempts: env.config.verify.max_attempts,
		});
		if (!dryRun && env.config.loop.checkpoint !== "off") {
			if (disposition === "carry") {
				env.store.loop.carried = live.id;
				live.interrupted_thinking = result.thinking?.trim() || undefined;
				console.error("  kept the working tree: the worker ran out of clock, not out of ideas");
			} else if (disposition === "preserve") {
				// Out of attempts, and still nothing but a clock to blame. Reverting
				// here would throw away every attempt's work at the exact moment a
				// human is about to be handed the problem, and committing it leaves
				// the tree clean for whatever the queue does next — a promoted plan
				// has to start from an empty diff.
				env.store.loop.carried = "";
				live.interrupted_thinking = result.thinking?.trim() || undefined;
				const subject = `${env.config.loop.commit_prefix}(${live.id}): incomplete — out of time after ${attempts} attempts`;
				if (await commitAll(env.cwd, `${subject}\n\n${live.title}`)) {
					console.error(`  committed the unfinished work rather than discarding it: ${subject}`);
				}
			} else {
				env.store.loop.carried = "";
				const base = env.store.loop.base_commit ?? "";
				if (await revertTo(env.cwd, base)) console.error(`  reverted the working tree to ${base.slice(0, 7)}`);
				else console.error("  could not revert the working tree; the next iteration may refuse to start");
			}
		}

		// A cut-off act is the strongest size signal there is, so record it here,
		// where `live` is the row the promote check below actually reads. Planning
		// rounds are exempt: a short round is not a broken one, timedOutRound()
		// already judges those on what they landed.
		if (result.timedOut && !planning) noteBudgetOverflow(env, live, budgetMs, cost);

		// Out of attempts. An oversized task becomes a plan; anything else blocks.
		//
		// Held until here rather than acted on at the first rejection, which is
		// how this was first written and is strictly worse. Run 12 rejected a
		// scaffold once, for a reason that had nothing to do with its size — the
		// task asked for evidence the verifier could not be shown — and because a
		// Gradle/Compose scaffold inherently touches twelve files, that single
		// rejection converted a nearly-right task into a plan with its other two
		// attempts unspent. Breaking a scaffold into pieces then makes it worse:
		// no piece of a scaffold builds on its own, so every child fails the gate
		// its parent would have passed.
		//
		// One rejection is ordinary. Three rejections on a task that is also
		// oversized is the signal — that is when retrying the same oversized
		// prompt has stopped being worth the tokens.
		if (attempts >= env.config.verify.max_attempts) {
			if (env.config.atomic.on_overflow === "promote" && live.overflowed && assignmentFor(live) === "act") {
				promoteToPlan(env.store, live, `Promoted to plan: ${live.overflow_reason ?? "over budget"}`);
				live.research_budget = researchBudgetOf(live, env.config.plan.research_budget);
				persist();
				console.error(`↑ ${live.id} promoted to plan — ${live.overflow_reason}; its next steps get decided next`);
				continue;
			}
			markBlocked(env.store, live, `Blocked after ${attempts} attempts: ${verdict.reason}`);
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
