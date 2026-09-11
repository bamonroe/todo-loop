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
import { DEFAULT_CONFIG_FILE, loadConfig, splitModelRef, type Config } from "./config.ts";
import { commitAll, gatherEvidence, headCommit, isGitRepo, isTreeClean } from "./evidence.ts";
import { renderTaskPrompt } from "./prompt.ts";
import {
	counts,
	DEFAULT_STORE_FILE,
	findTask,
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
import { ollamaCompleter, verify, type Verdict } from "./verify.ts";

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
	const config = loadConfig(cwd, str(flags, "config") || undefined);
	const storeFile = resolveStorePath(cwd, str(flags, "file") || undefined);
	return { cwd, config, storeFile, store: loadStore(storeFile) };
}

function verifierFor(env: Env, signal?: AbortSignal) {
	const { model } = splitModelRef(env.config.models.verifier);
	return ollamaCompleter(env.config.ollama.base_url, model, signal);
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
	});
}

async function verifyTask(env: Env, task: Task, signal?: AbortSignal): Promise<Verdict> {
	if (!env.config.verify.enabled) return { pass: true, reason: "Verification disabled.", mechanical: true };
	const evidence = await evidenceFor(env);
	return verify(task, evidence, verifierFor(env, signal));
}

const USAGE = `todo — autonomous todo loop for pi

  todo init                      Write ${DEFAULT_CONFIG_FILE} and ${DEFAULT_STORE_FILE} starters
  todo status                    Show the queue
  todo next [--id]               Print the next task's prompt (exit 3 when empty)
  todo start                     Claim the next task and print its prompt
  todo add <id> <title...>       Append a task (--detail "...", --parent <id>)
  todo done <id> [summary...]    Mark done without verifying
  todo block <id> <reason...>    Mark blocked
  todo reset <id>                Return a task to todo and clear attempts
  todo verify [id]               Gather evidence and print the verdict as JSON
  todo complete <id> [summary]   Verify, then mark done or record the failure
  todo checkpoint [message...]   Commit everything in the working tree
  todo run [--max N] [--dry-run] Drive the queue with one pi process per task

Shared flags: --cwd <dir> --file <todo.toml> --config <todoloop.toml>`;

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

function commandStatus(env: Env): number {
	const stats = counts(env.store);
	const tree = renderTree(env.store);
	console.log(tree || "(no tasks)");
	console.log(
		`\n${stats.done} done · ${stats.todo} todo · ${stats.doing} in progress · ${stats.blocked} blocked` +
			`\nloop: ${env.store.loop.running ? "running" : "stopped"}` +
			(env.store.loop.current ? ` · current ${env.store.loop.current}` : "") +
			` · iteration ${env.store.loop.iterations}`,
	);
	if (env.store.loop.last_failure) console.log(`last failure: ${env.store.loop.last_failure}`);
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
		renderTaskPrompt(env.store, task, {
			mode: "standalone",
			lastFailure: env.store.loop.last_failure,
			attempts: task.attempts,
			maxAttempts: env.config.verify.max_attempts,
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
	const task: Task = { id, title: titleParts.join(" "), status: "todo", attempts: 0 };
	const detail = str(flags, "detail");
	if (detail) task.detail = detail;
	const parent = str(flags, "parent");
	if (parent) task.parent = parent;
	env.store.tasks.push(task);
	rollup(env.store);
	saveStore(env.storeFile, env.store);
	console.log(`added ${id}`);
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
		await checkpoint(env, task, summaryParts.join(" "));
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

async function checkpoint(env: Env, task: Task, summary: string): Promise<void> {
	if (env.config.loop.checkpoint !== "commit") return;
	if (!(await isGitRepo(env.cwd))) return;
	const message = `${env.config.loop.commit_prefix}(${task.id}): ${summary || task.title}`;
	if (await commitAll(env.cwd, message)) console.log(`committed: ${message}`);
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

function runPi(env: Env, prompt: string, dryRun: boolean): Promise<number> {
	if (dryRun) {
		console.log(`--- would run pi with prompt ---\n${prompt}\n--- end prompt ---`);
		return Promise.resolve(0);
	}
	const { provider, model } = splitModelRef(env.config.models.worker);
	const args = ["-p", "--provider", provider, "--model", model, "--", prompt];
	return new Promise((resolve) => {
		const child = spawn("pi", args, { cwd: env.cwd, stdio: "inherit" });
		child.on("error", (error) => {
			console.error(`failed to launch pi: ${error.message}`);
			resolve(127);
		});
		child.on("close", (code) => resolve(code ?? EXIT_ERROR));
	});
}

async function commandRun(env: Env, flags: Flags): Promise<number> {
	const dryRun = bool(flags, "dry-run");
	const maxIterations = Number(str(flags, "max", String(env.config.loop.max_iterations))) || 1;

	env.store.loop.running = true;
	env.store.loop.iterations = 0;
	saveStore(env.storeFile, env.store);

	for (let iteration = 1; iteration <= maxIterations; iteration++) {
		env.store = loadStore(env.storeFile);
		if (!env.store.loop.running) {
			console.log("loop stopped");
			return EXIT_OK;
		}

		const task = nextLeaf(env.store);
		if (!task) {
			env.store.loop.running = false;
			saveStore(env.storeFile, env.store);
			console.log(`queue empty after ${iteration - 1} iterations`);
			return EXIT_OK;
		}

		if (env.config.loop.checkpoint === "require-clean" && !(await isTreeClean(env.cwd))) {
			console.error("working tree is dirty and checkpoint = require-clean; refusing to start a task");
			env.store.loop.running = false;
			saveStore(env.storeFile, env.store);
			return EXIT_ERROR;
		}

		markDoing(env.store, task, await headCommit(env.cwd));
		env.store.loop.iterations = iteration;
		saveStore(env.storeFile, env.store);

		const prompt = renderTaskPrompt(env.store, task, {
			mode: "standalone",
			lastFailure: env.store.loop.last_failure,
			attempts: task.attempts,
			maxAttempts: env.config.verify.max_attempts,
		});

		console.log(`\n=== [${iteration}/${maxIterations}] ${task.id}: ${task.title} ===`);
		const code = await runPi(env, prompt, dryRun);
		if (code !== 0) console.error(`pi exited ${code}; verifying anyway`);

		env.store = loadStore(env.storeFile);
		const current = findTask(env.store, task.id);
		if (!current) continue;

		const verdict = dryRun ? { pass: true, reason: "dry run" } : await verifyTask(env, current);
		if (verdict.pass) {
			markDone(env.store, current, verdict.reason);
			saveStore(env.storeFile, env.store);
			await checkpoint(env, current, current.summary ?? "");
			console.log(`✓ ${current.id} verified`);
			continue;
		}

		const attempts = recordFailure(env.store, current, verdict.reason);
		console.error(`✗ ${current.id} rejected (attempt ${attempts}/${env.config.verify.max_attempts}): ${verdict.reason}`);
		if (attempts >= env.config.verify.max_attempts) {
			markBlocked(env.store, current, `Blocked after ${attempts} attempts: ${verdict.reason}`);
			saveStore(env.storeFile, env.store);
			console.error("halting: a task the worker cannot finish should not become an unbounded token burn");
			return EXIT_ERROR;
		}
		saveStore(env.storeFile, env.store);
	}

	env.store = loadStore(env.storeFile);
	env.store.loop.running = false;
	saveStore(env.storeFile, env.store);
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
			return commandStatus(env);
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
