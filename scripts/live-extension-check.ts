#!/usr/bin/env -S node --experimental-strip-types
/**
 * Drives the extension inside a real pi session over RPC.
 *
 * The unit tests run the extension against a stand-in for the ExtensionAPI,
 * which proves the wiring but not that pi agrees with it — in particular that
 * newSession works from a command, that the queued /todo-advance is dispatched,
 * and that the tools are visible to the model at all.
 *
 * The queue is deliberately mixed: a plain act first, then a plan. That covers
 * both assignment kinds and, more to the point, exercises todo_add against a
 * real model — the fake API will happily accept a round no local model would
 * actually produce. The children it invents are printed at the end, because
 * whether a small model decomposes *well* is a judgement only a human can make.
 *
 * Needs a live model, so it is not part of `node --test`. Run it directly:
 *
 *   node scripts/live-extension-check.ts [--keep] [--timeout 2700]
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadStore } from "../src/store.ts";

const PACKAGE_ROOT = path.join(import.meta.dirname, "..");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const timeoutMs = Number(args[args.indexOf("--timeout") + 1] || 2700) * 1000;

const QUEUE = `
[loop]
running = false
current = ""
iterations = 0
base_commit = ""
last_failure = ""

[[task]]
id = "greet"
title = "Add a greet function"
status = "todo"
attempts = 0
detail = """
Create greet.ts exporting \`greet(name: string): string\` returning "hello, <name>".
Plain TypeScript, type annotations only, run directly by node. No test file needed.
"""

[[task]]
id = "transforms"
title = "Add the text transform helpers"
level = "plan"
status = "todo"
attempts = 0
detail = """
Two helpers are needed, and they belong in separate files:

- shout.ts exporting \`shout(text: string): string\` — the text uppercased with
  an exclamation mark appended.
- whisper.ts exporting \`whisper(text: string): string\` — the text lowercased,
  wrapped in parentheses.

Plain TypeScript, type annotations only, run directly by node. No test files.
"""
`;

const CONFIG = `
[models]
worker = "inherit"
verifier = "opencode/qwen3.6-plus"

[verify]
enabled = true
max_attempts = 2

[loop]
checkpoint = "commit"
on_silent_stop = "halt"
`;

function scratchRepo(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-live-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "README.md"), "scratch\n");
	execFileSync("git", ["add", "-A"], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "todo.toml"), QUEUE);
	fs.writeFileSync(path.join(repo, "todoloop.toml"), CONFIG);
	return repo;
}

const repo = scratchRepo();
console.log(`workspace: ${repo}`);

const child = spawn("pi", ["--mode", "rpc", "-e", PACKAGE_ROOT], {
	cwd: repo,
	stdio: ["pipe", "pipe", "inherit"],
});

const extensionErrors: string[] = [];
let buffer = "";

child.stdout.on("data", (chunk: Buffer) => {
	buffer += chunk.toString();
	// Strict JSONL: split on LF only.
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		let event: { type?: string; error?: string; message?: unknown };
		try {
			event = JSON.parse(line.replace(/\r$/, ""));
		} catch {
			continue;
		}
		if (event.type === "extension_error") {
			extensionErrors.push(JSON.stringify(event));
			console.error(`extension_error: ${JSON.stringify(event)}`);
		}
		if (event.type === "agent_settled") console.log("· agent settled");
		if (event.type === "session_start") console.log("· session started");
	}
});

const send = (payload: Record<string, unknown>): void => {
	child.stdin.write(`${JSON.stringify(payload)}\n`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Give pi a moment to load the extension before issuing the command.
await sleep(3000);
console.log("→ /todo-run");
send({ id: "run", type: "prompt", message: "/todo-run" });

const deadline = Date.now() + timeoutMs;
let outcome = "timed out";
let lastReport = "";

while (Date.now() < deadline) {
	await sleep(5000);
	const store = loadStore(path.join(repo, "todo.toml"));
	const report = `${store.tasks.map((task) => `${task.id}=${task.status}/${task.attempts}`).join(" ")} running=${store.loop.running}`;
	if (report !== lastReport) {
		console.log(`· ${report}`);
		lastReport = report;
	}
	if (store.tasks.every((task) => task.status === "done")) {
		outcome = "done";
		break;
	}
	if (store.tasks.some((task) => task.status === "blocked")) {
		outcome = "blocked";
		break;
	}
	if (!store.loop.running && store.tasks.some((task) => task.status === "doing")) {
		outcome = "halted";
		break;
	}
}

send({ type: "exit" });
await sleep(1000);
child.kill();

const store = loadStore(path.join(repo, "todo.toml"));
const created = ["greet.ts", "shout.ts", "whisper.ts"].filter((file) => fs.existsSync(path.join(repo, file)));
const spawned = store.tasks.filter((task) => task.parent === "transforms");
const commits = execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).trim().split("\n");

console.log("\n--- result ---");
console.log(`outcome:          ${outcome}`);
for (const task of store.tasks) console.log(`  ${task.id}: ${task.status} (${task.attempts} attempts)`);
console.log(`files created:    ${created.join(", ") || "(none)"}`);
console.log(`planning round:   ${spawned.length} item(s) from the plan`);
for (const task of spawned) {
	console.log(`  - ${task.id} [${task.level ?? "task"}] ${task.status}: ${task.title}`);
	if (task.detail) console.log(`      ${task.detail.trim().replace(/\n/g, "\n      ")}`);
}
console.log(`commits:          ${commits.length}`);
console.log(`last failure:     ${store.loop.last_failure || "(none)"}`);
console.log(`extension errors: ${extensionErrors.length}`);

if (!keep) fs.rmSync(repo, { recursive: true, force: true });
else console.log(`\nkept ${repo}`);

// More than one task means the automatic advance — a tool queueing a command
// that replaces the session — is exercised for real, not just the first kickoff.
// A non-empty round means todo_add reached the model and the mechanical gate
// accepted what came back.
const passed =
	outcome === "done" && created.length === 3 && spawned.length > 0 && extensionErrors.length === 0;
console.log(passed ? "\nPASS" : "\nFAIL");
process.exit(passed ? 0 : 1);
