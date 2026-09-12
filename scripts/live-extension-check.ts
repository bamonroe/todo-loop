#!/usr/bin/env -S node --experimental-strip-types
/**
 * Drives the extension inside a real pi session over RPC.
 *
 * The unit tests run the extension against a stand-in for the ExtensionAPI,
 * which proves the wiring but not that pi agrees with it — in particular that
 * newSession works from a command, that the queued /todo-advance is dispatched,
 * and that the tools are visible to the model at all.
 *
 * Needs a live model, so it is not part of `node --test`. Run it directly:
 *
 *   node scripts/live-extension-check.ts [--keep] [--timeout 1800]
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
const timeoutMs = Number(args[args.indexOf("--timeout") + 1] || 1800) * 1000;

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
`;

const CONFIG = `
[models]
worker = "inherit"
verifier = "ollama/qwen3.5:9b"

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
	const task = store.tasks[0];
	const report = `${task.status} attempts=${task.attempts} running=${store.loop.running}`;
	if (report !== lastReport) {
		console.log(`· ${report}`);
		lastReport = report;
	}
	if (task.status === "done") {
		outcome = "done";
		break;
	}
	if (task.status === "blocked" || (!store.loop.running && task.status !== "todo")) {
		outcome = task.status === "blocked" ? "blocked" : "halted";
		break;
	}
}

send({ type: "exit" });
await sleep(1000);
child.kill();

const store = loadStore(path.join(repo, "todo.toml"));
const greetExists = fs.existsSync(path.join(repo, "greet.ts"));

console.log("\n--- result ---");
console.log(`outcome:          ${outcome}`);
console.log(`task status:      ${store.tasks[0].status}`);
console.log(`attempts:         ${store.tasks[0].attempts}`);
console.log(`greet.ts created: ${greetExists}`);
console.log(`last failure:     ${store.loop.last_failure || "(none)"}`);
console.log(`extension errors: ${extensionErrors.length}`);
if (greetExists) console.log(`\n${fs.readFileSync(path.join(repo, "greet.ts"), "utf8")}`);

if (!keep) fs.rmSync(repo, { recursive: true, force: true });
else console.log(`\nkept ${repo}`);

const passed = outcome === "done" && greetExists && extensionErrors.length === 0;
console.log(passed ? "\nPASS" : "\nFAIL");
process.exit(passed ? 0 : 1);
