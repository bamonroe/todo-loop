/**
 * Drives the extension against a fake pi API. Covers the wiring that only shows
 * up at runtime: which hook fires when, what a tool returns, and what ends up in
 * todo.toml afterwards.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";
import createExtension from "../extension/index.ts";
import { loadStore } from "../src/store.ts";

type Handler = (...args: never[]) => unknown;

interface Harness {
	repo: string;
	commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
	tools: Map<string, { execute: (...args: never[]) => Promise<Record<string, unknown>> }>;
	events: Map<string, Handler[]>;
	sent: { text: string; options?: Record<string, unknown> }[];
	notifications: string[];
	newSessions: string[];
	verdict: string;
	ctx: Record<string, unknown>;
	commandCtx: Record<string, unknown>;
	emit: (event: string, payload: unknown) => Promise<unknown>;
}

const CONFIG = `
[models]
worker = "inherit"
verifier = "ollama/fake-verifier"

[verify]
enabled = true
max_attempts = 3
require_tests_pass = true

[loop]
checkpoint = "off"
on_silent_stop = "halt"

[context]
prune_at_fraction = 0.5
keep_full_turns = 2
stub_min_bytes = 100
tool_output_max_bytes = 64
`;

const QUEUE = `
[loop]
running = false
current = ""
iterations = 0

[[task]]
id = "greet"
title = "Add a greet function"
status = "todo"
attempts = 0
detail = "Create greet.ts exporting greet(name)."

[[task]]
id = "farewell"
title = "Add a farewell function"
status = "todo"
attempts = 0
`;

function build(): Harness {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "todo-loop-ext-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "README.md"), "scratch\n");
	execFileSync("git", ["add", "-A"], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "todoloop.toml"), CONFIG);
	fs.writeFileSync(path.join(repo, "todo.toml"), QUEUE);

	const harness = {
		repo,
		commands: new Map(),
		tools: new Map(),
		events: new Map(),
		sent: [],
		notifications: [],
		newSessions: [],
		verdict: '{"pass": true, "reason": "the diff adds the function"}',
	} as Partial<Harness> as Harness;

	const pi = {
		registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			harness.commands.set(name, spec.handler);
		},
		registerTool: (spec: { name: string; execute: (...args: never[]) => Promise<Record<string, unknown>> }) => {
			harness.tools.set(spec.name, spec);
		},
		on: (event: string, handler: Handler) => {
			harness.events.set(event, [...(harness.events.get(event) ?? []), handler]);
		},
		sendUserMessage: (text: string, options?: Record<string, unknown>) => {
			harness.sent.push({ text, options });
		},
	};

	harness.ctx = {
		cwd: repo,
		hasUI: true,
		signal: undefined,
		ui: { notify: (message: string) => harness.notifications.push(message) },
		model: { contextWindow: 1000 },
		getContextUsage: () => ({ tokens: 900, percent: 90, contextWindow: 1000 }),
		modelRegistry: {
			find: () => ({ id: "fake-verifier" }),
			hasConfiguredAuth: () => true,
			complete: async () => ({ content: [{ type: "text", text: harness.verdict }], usage: { input: 10, output: 5 } }),
		},
	};

	harness.commandCtx = {
		...harness.ctx,
		waitForIdle: async () => {},
		newSession: async (options: { withSession?: (ctx: unknown) => Promise<void> }) => {
			await options.withSession?.({
				sendUserMessage: async (text: string) => {
					harness.newSessions.push(text);
				},
			});
			return { cancelled: false };
		},
	};

	harness.emit = async (event: string, payload: unknown) => {
		let last: unknown;
		for (const handler of harness.events.get(event) ?? []) {
			last = await (handler as (a: unknown, b: unknown) => unknown)(payload, harness.ctx);
		}
		return last;
	};

	// biome-ignore lint: the fake stands in for the real ExtensionAPI surface
	createExtension(pi as never);
	return harness;
}

let h: Harness;
const store = () => loadStore(path.join(h.repo, "todo.toml"));
const run = (name: string, args = "") => h.commands.get(name)!(args, h.commandCtx);
const call = (name: string, params: Record<string, unknown>) =>
	h.tools.get(name)!.execute("id" as never, params as never, undefined as never, undefined as never, h.ctx as never);

function writeWork(): void {
	fs.writeFileSync(path.join(h.repo, "greet.ts"), "export const greet = (name: string) => `hello, ${name}`;\n");
}

beforeEach(() => {
	h = build();
});

test("registers the documented commands and tools", () => {
	assert.deepEqual([...h.commands.keys()].sort(), ["todo-advance", "todo-run", "todo-status", "todo-stop"]);
	assert.deepEqual([...h.tools.keys()].sort(), ["todo_add", "todo_block", "todo_complete"]);
	for (const event of ["before_agent_start", "context", "tool_result", "session_before_compact", "agent_settled"]) {
		assert.ok(h.events.has(event), `missing handler for ${event}`);
	}
});

test("todo-run claims the first leaf and kicks off a fresh session", async () => {
	await run("todo-run");
	const current = store();
	assert.equal(current.loop.running, true);
	assert.equal(current.loop.current, "greet");
	assert.equal(current.tasks[0].status, "doing");
	assert.equal(h.newSessions.length, 1);
	assert.match(h.newSessions[0], /Add a greet function/);
	assert.match(h.newSessions[0], /todo_complete/);
});

test("the task is pinned into the system prompt", async () => {
	await run("todo-run");
	const result = (await h.emit("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
	assert.match(result.systemPrompt, /^BASE/);
	assert.match(result.systemPrompt, /greet \[task\]: Add a greet function/);
});

test("a passing verdict closes the task and queues the advance", async () => {
	await run("todo-run");
	writeWork();
	const result = await call("todo_complete", { summary: "added greet.ts" });
	assert.equal(result.terminate, true);
	assert.deepEqual(result.usage, { input: 10, output: 5 });

	const current = store();
	assert.equal(current.tasks[0].status, "done");
	assert.equal(current.tasks[0].summary, "added greet.ts");
	assert.equal(current.loop.current, "");
	assert.deepEqual(h.sent, [{ text: "/todo-advance", options: { deliverAs: "followUp", expandPromptTemplates: true } }]);
});

test("a rejection resumes the worker instead of ending the turn", async () => {
	await run("todo-run");
	writeWork();
	h.verdict = '{"pass": false, "reason": "greet.ts does not export greet"}';
	const result = await call("todo_complete", { summary: "done I think" });

	assert.equal(result.terminate, undefined);
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /does not export greet/);

	const current = store();
	assert.equal(current.tasks[0].status, "doing");
	assert.equal(current.tasks[0].attempts, 1);
	assert.equal(current.loop.last_failure, "greet.ts does not export greet");
	assert.equal(h.sent.length, 0);
});

test("three rejections block the task and stop the loop", async () => {
	await run("todo-run");
	writeWork();
	h.verdict = '{"pass": false, "reason": "still missing the export"}';
	await call("todo_complete", { summary: "attempt one" });
	await call("todo_complete", { summary: "attempt two" });
	const result = await call("todo_complete", { summary: "attempt three" });

	assert.equal(result.terminate, true);
	const current = store();
	assert.equal(current.tasks[0].status, "blocked");
	assert.equal(current.loop.running, false);
	assert.match(current.tasks[0].reason ?? "", /Blocked after 3 attempts/);
});

test("an empty diff is rejected before the verifier is consulted", async () => {
	await run("todo-run");
	h.verdict = '{"pass": true, "reason": "trust me"}';
	const result = await call("todo_complete", { summary: "nothing to see" });
	assert.equal(result.terminate, undefined);
	assert.match(JSON.stringify(result.content), /No file changes/);
	assert.equal(store().tasks[0].attempts, 1);
});

test("todo_block halts immediately", async () => {
	await run("todo-run");
	const result = await call("todo_block", { reason: "the spec contradicts itself" });
	assert.equal(result.terminate, true);
	const current = store();
	assert.equal(current.tasks[0].status, "blocked");
	assert.equal(current.loop.running, false);
});

test("a run that ends without todo_complete halts rather than advancing", async () => {
	await run("todo-run");
	await h.emit("agent_start", {});
	await h.emit("agent_settled", {});

	const current = store();
	assert.equal(current.loop.running, false);
	assert.equal(current.tasks[0].status, "doing");
	assert.match(h.notifications.join("\n"), /ended without calling todo_complete/);
});

test("agent_settled is silent when the task already resolved", async () => {
	await run("todo-run");
	writeWork();
	await h.emit("agent_start", {});
	await call("todo_complete", { summary: "added greet.ts" });
	h.notifications.length = 0;
	await h.emit("agent_settled", {});
	assert.equal(h.notifications.length, 0);
});

test("old bulky tool results are elided once context is tight", async () => {
	await run("todo-run");
	const bulk = "x".repeat(4000);
	const messages = [
		{ role: "user", content: [{ type: "text", text: "go" }] },
		{ role: "toolResult", toolName: "read", content: [{ type: "text", text: bulk }] },
		{ role: "assistant", content: [{ type: "text", text: "thinking" }] },
		{ role: "toolResult", toolName: "read", content: [{ type: "text", text: bulk }] },
		{ role: "assistant", content: [{ type: "text", text: "still thinking" }] },
		{ role: "toolResult", toolName: "read", content: [{ type: "text", text: bulk }] },
		{ role: "assistant", content: [{ type: "text", text: "done" }] },
	];
	const result = (await h.emit("context", { messages })) as { messages: typeof messages };
	assert.ok(result, "expected the context handler to rewrite messages");

	const texts = result.messages.map((message) => JSON.stringify(message.content));
	assert.match(texts[1], /result elided/);
	assert.doesNotMatch(texts[5], /result elided/);
	assert.equal(texts[0].includes("go"), true);
});

test("context is left alone while there is headroom", async () => {
	await run("todo-run");
	h.ctx.getContextUsage = () => ({ tokens: 100, percent: 10, contextWindow: 1000 });
	const result = await h.emit("context", {
		messages: [{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "y".repeat(4000) }] }],
	});
	assert.equal(result, undefined);
});

test("bulky tool output is capped and spilled to a file", async () => {
	await run("todo-run");
	const text = "line\n".repeat(500);
	const result = (await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text }] })) as {
		content: { text: string }[];
	};
	assert.ok(result);
	const out = result.content[0].text;
	assert.match(out, /output capped at 64 bytes/);
	const spill = out.match(/full text at ([^\]]+)\]/)?.[1];
	assert.ok(spill && fs.existsSync(spill));
	assert.equal(fs.readFileSync(spill, "utf8"), text);
});

test("small tool output passes through untouched", async () => {
	await run("todo-run");
	const result = await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] });
	assert.equal(result, undefined);
});

test("compaction returns fields rather than prose", async () => {
	await run("todo-run");
	writeWork();
	h.verdict = '{"pass": false, "reason": "the export is missing"}';
	await call("todo_complete", { summary: "attempt" });

	const result = (await h.emit("session_before_compact", {
		preparation: { firstKeptEntryId: "entry-9", tokensBefore: 12345 },
	})) as { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number } };

	assert.equal(result.compaction.firstKeptEntryId, "entry-9");
	assert.equal(result.compaction.tokensBefore, 12345);
	assert.match(result.compaction.summary, /task:\s+greet \[task\]: Add a greet function/);
	assert.match(result.compaction.summary, /attempt:\s+2 of 3/);
	assert.match(result.compaction.summary, /files_touched:.*greet\.ts/);
	assert.match(result.compaction.summary, /last_failure:\s+the export is missing/);
});

test("hooks stay out of the way when the loop is not running", async () => {
	assert.equal(await h.emit("before_agent_start", { systemPrompt: "BASE" }), undefined);
	assert.equal(
		await h.emit("context", {
			messages: [{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "z".repeat(4000) }] }],
		}),
		undefined,
	);
	assert.equal(await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "q".repeat(4000) }] }), undefined);
});

test("todo-stop leaves progress in place", async () => {
	await run("todo-run");
	await run("todo-stop");
	const current = store();
	assert.equal(current.loop.running, false);
	assert.equal(current.tasks[0].status, "doing");
});

test("todo-advance moves to the next task in a fresh session", async () => {
	await run("todo-run");
	writeWork();
	await call("todo_complete", { summary: "added greet.ts" });
	await run("todo-advance");

	const current = store();
	assert.equal(current.loop.current, "farewell");
	assert.equal(h.newSessions.length, 2);
	assert.match(h.newSessions[1], /Add a farewell function/);
});

test("the loop reports an empty queue instead of spinning", async () => {
	await run("todo-run");
	writeWork();
	await call("todo_complete", { summary: "one" });
	await run("todo-advance");
	fs.writeFileSync(path.join(h.repo, "farewell.ts"), "export const bye = () => 'bye';\n");
	await call("todo_complete", { summary: "two" });
	await run("todo-advance");

	assert.equal(store().loop.running, false);
	assert.match(h.notifications.join("\n"), /Queue empty/);
});

// ------------------------------------------------------ levels and breakdowns

/** Rebuild the harness with an epic at the head of the queue. */
function withEpic(overrides = ""): void {
	fs.writeFileSync(
		path.join(h.repo, "todo.toml"),
		`
[loop]
running = false
current = ""
iterations = 0

[[task]]
id = "auth"
title = "Rebuild authentication"
level = "epic"
status = "todo"
attempts = 0
`,
	);
	if (overrides) fs.writeFileSync(path.join(h.repo, "todoloop.toml"), CONFIG + overrides);
}

test("a childless epic is handed out as a breakdown, not as work", async () => {
	withEpic();
	await run("todo-run");
	assert.equal(h.newSessions.length, 1);
	assert.match(h.newSessions[0], /You are \*\*not\*\* implementing it/);
	assert.match(h.newSessions[0], /todo_add/);
});

test("todo_add files children under the epic", async () => {
	withEpic();
	await run("todo-run");
	const first = await call("todo_add", { title: "Rotate the signing secrets", detail: "Touch src/keys.ts only." });
	assert.equal(first.isError, undefined);
	await call("todo_add", { title: "Add a TOTP second factor", detail: "New file src/mfa.ts.", level: "scope" });

	const tasks = store().tasks;
	assert.deepEqual(
		tasks.map((t) => t.id),
		["auth", "auth.rotate-the-signing-secrets", "auth.add-a-totp-second-factor"],
	);
	assert.equal(tasks[1].parent, "auth");
	assert.equal(tasks[1].detail, "Touch src/keys.ts only.");
	assert.equal(tasks[2].level, "scope");
});

test("todo_add refuses on an ordinary task", async () => {
	await run("todo-run"); // the default queue head, "greet", is a plain task
	const result = await call("todo_add", { title: "Something else entirely", detail: "..." });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /is a task, not a breakdown/);
	assert.equal(store().tasks.length, 2);
});

test("a breakdown closes with no model call and no test run", async () => {
	withEpic();
	await run("todo-run");
	await call("todo_add", { title: "Rotate the signing secrets", detail: "src/keys.ts" });
	await call("todo_add", { title: "Add a TOTP second factor", detail: "src/mfa.ts" });

	// Any verdict the fake model would return is the wrong answer here; the
	// breakdown must be decided without asking it at all.
	h.verdict = '{"pass": false, "reason": "the model should never have been consulted"}';
	const result = await call("todo_complete", { summary: "split into two" });

	assert.equal(result.terminate, true);
	assert.equal(result.isError, undefined);
	assert.equal(store().tasks[0].status, "done");
	assert.equal(result.usage, undefined);
});

test("a breakdown that touched the tree is rejected", async () => {
	withEpic();
	await run("todo-run");
	await call("todo_add", { title: "Rotate the signing secrets", detail: "src/keys.ts" });
	await call("todo_add", { title: "Add a TOTP second factor", detail: "src/mfa.ts" });
	writeWork(); // a scope that wrote code

	const result = await call("todo_complete", { summary: "split it and got started" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /not code/);
	assert.equal(store().tasks[0].status, "doing");
});

test("an empty breakdown is rejected without consulting the verifier", async () => {
	withEpic();
	await run("todo-run");
	const result = await call("todo_complete", { summary: "nothing to split" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /no child tasks/);
});

test("compaction inside a task flags it as too coarse", async () => {
	await run("todo-run");
	writeWork();
	await h.emit("session_before_compact", {
		preparation: { firstKeptEntryId: "e1", tokensBefore: 9000 },
	});
	await call("todo_complete", { summary: "done" });

	const done = store().tasks[0];
	assert.equal(done.overflowed, true);
	assert.match(done.overflow_reason ?? "", /compaction fired/);
	// Passing is still passing: size is a separate question from correctness.
	assert.equal(done.status, "done");
});

test("with on_overflow = promote, an oversized failure becomes a scope", async () => {
	fs.writeFileSync(path.join(h.repo, "todoloop.toml"), `${CONFIG}\n[atomic]\non_overflow = "promote"\nmax_files = 5\n`);
	await run("todo-run");
	writeWork();
	await h.emit("session_before_compact", { preparation: { firstKeptEntryId: "e1", tokensBefore: 9000 } });

	h.verdict = '{"pass": false, "reason": "greet is still not exported"}';
	const result = await call("todo_complete", { summary: "tried" });

	assert.equal(result.terminate, true);
	const task = store().tasks[0];
	assert.equal(task.level, "scope");
	assert.equal(task.status, "todo");
	assert.equal(task.attempts, 0);
	assert.deepEqual(h.sent, [{ text: "/todo-advance", options: { deliverAs: "followUp", expandPromptTemplates: true } }]);
});

test("the default is to warn, not to restructure the queue", async () => {
	await run("todo-run");
	writeWork();
	await h.emit("session_before_compact", { preparation: { firstKeptEntryId: "e1", tokensBefore: 9000 } });
	h.verdict = '{"pass": false, "reason": "greet is still not exported"}';
	await call("todo_complete", { summary: "tried" });

	const task = store().tasks[0];
	assert.equal(task.level, undefined);
	assert.equal(task.overflowed, true);
	assert.equal(task.attempts, 1);
});

test("a breakdown carries its children across compaction", async () => {
	withEpic();
	await run("todo-run");
	await call("todo_add", { title: "Rotate the signing secrets", detail: "src/keys.ts" });

	const result = (await h.emit("session_before_compact", {
		preparation: { firstKeptEntryId: "e1", tokensBefore: 9000 },
	})) as { compaction: { summary: string } };

	// Without this the worker forgets what it already added and duplicates it.
	assert.match(result.compaction.summary, /children_added: auth\.rotate-the-signing-secrets/);
	assert.match(result.compaction.summary, /Do not re-add children/);
	assert.match(result.compaction.summary, /Write no code/);
});
