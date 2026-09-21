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
import { loadStore, saveStore } from "../src/store.ts";

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
		model: { provider: "ollama", id: "fake-worker", contextWindow: 1000 },
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
	assert.deepEqual([...h.tools.keys()].sort(), ["todo_add", "todo_block", "todo_complete", "todo_read"]);
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

test("a worker model the session is not on is called out at the start of the run", async () => {
	// models.worker binds the shell driver; in-session the loop runs on whatever
	// model the session already has. Silence here means discovering overnight
	// that the queue ran on something else entirely.
	fs.writeFileSync(
		path.join(h.repo, "todoloop.toml"),
		CONFIG.replace('worker = "inherit"', 'worker = "openai-codex/gpt-5.6-terra"'),
	);
	await run("todo-run");
	const warning = h.notifications.find((message) => message.includes("models.worker"));
	assert.ok(warning, `no worker-model warning in ${JSON.stringify(h.notifications)}`);
	assert.match(warning, /openai-codex\/gpt-5\.6-terra/);
	assert.match(warning, /ollama\/fake-worker/);
	// Still a warning, not a refusal — the run goes ahead.
	assert.equal(h.newSessions.length, 1);
});

test("a worker model matching the session's is left unmentioned", async () => {
	fs.writeFileSync(path.join(h.repo, "todoloop.toml"), CONFIG.replace('worker = "inherit"', 'worker = "ollama/fake-worker"'));
	await run("todo-run");
	assert.equal(
		h.notifications.find((message) => message.includes("models.worker")),
		undefined,
	);
});

test("the task is pinned into the system prompt", async () => {
	await run("todo-run");
	const result = (await h.emit("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
	assert.match(result.systemPrompt, /^BASE/);
	assert.match(result.systemPrompt, /greet \[code\]: Add a greet function/);
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

test("old thinking is cut to its tail, recent thinking is left whole", async () => {
	await run("todo-run");
	const reasoning = `${"a".repeat(4000)}\nthe conclusion is that release() is idempotent`;
	const messages = [
		{ role: "user", content: [{ type: "text", text: "go" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: reasoning }, { type: "text", text: "one" }] },
		{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "f" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: reasoning }, { type: "text", text: "two" }] },
		{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "f" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: reasoning }, { type: "text", text: "three" }] },
	];
	const result = (await h.emit("context", { messages })) as { messages: typeof messages };
	assert.ok(result, "expected the context handler to rewrite messages");

	const think = (i: number) =>
		(result.messages[i].content as { type: string; thinking?: string }[]).find((b) => b.type === "thinking")
			?.thinking ?? "";

	// Past keep_full_turns: shortened, but the end — where the conclusion is — survives.
	assert.ok(think(1).length < reasoning.length, "the old block is cut down");
	assert.match(think(1), /release\(\) is idempotent/, "and its conclusion is what is kept");
	// Inside keep_full_turns: untouched, so the turn it just took is fully in view.
	assert.equal(think(5), reasoning, "recent thinking is left whole");
	// Text blocks in the same message are not reasoning and are not the target.
	assert.match(JSON.stringify(result.messages[1].content), /"one"/);
});

test("thinking_keep_bytes = 0 drops old reasoning without emptying the block", async () => {
	fs.writeFileSync(
		path.join(h.repo, "todoloop.toml"),
		CONFIG.replace("tool_output_max_bytes = 64", "tool_output_max_bytes = 64\nthinking_keep_bytes = 0"),
	);
	await run("todo-run");
	const messages = [
		{ role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(4000) }] },
		{ role: "assistant", content: [{ type: "text", text: "a" }] },
		{ role: "assistant", content: [{ type: "text", text: "b" }] },
	];
	const result = (await h.emit("context", { messages })) as { messages: typeof messages };
	const block = (result.messages[0].content as { type: string; thinking?: string }[])[0];
	assert.equal(block.thinking, "[earlier reasoning dropped]");
	assert.notEqual(block.thinking, "", "an empty reasoning block is a wire-format problem we do not need");
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

test("a capped file read keeps the head, a capped command keeps the tail", async () => {
	await run("todo-run");
	const doc = `TOP OF FILE\n${"filler line\n".repeat(500)}END OF FILE`;

	const read = (await h.emit("tool_result", { toolName: "read", content: [{ type: "text", text: doc }] })) as {
		content: { text: string }[];
	};
	assert.match(read.content[0].text, /TOP OF FILE/);

	const bash = (await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: doc }] })) as {
		content: { text: string }[];
	};
	assert.match(bash.content[0].text, /END OF FILE/);
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
	assert.match(result.compaction.summary, /task:\s+greet \[code\]: Add a greet function/);
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

test("a plan with no round yet is handed out as planning, not as work", async () => {
	withEpic();
	await run("todo-run");
	assert.equal(h.newSessions.length, 1);
	assert.match(h.newSessions[0], /You are \*\*not\*\* implementing this/);
	assert.match(h.newSessions[0], /todo_add/);
});

test("todo_add files this round's items under the plan", async () => {
	withEpic();
	await run("todo-run");
	const first = await call("todo_add", { title: "Rotate the signing secrets", detail: "Touch src/keys.ts only." });
	assert.equal(first.isError, undefined);
	await call("todo_add", { title: "Add a TOTP second factor", detail: "New file src/mfa.ts.", level: "plan" });

	const tasks = store().tasks;
	assert.deepEqual(
		tasks.map((t) => t.id),
		["auth", "auth.rotate-the-signing-secrets", "auth.add-a-totp-second-factor"],
	);
	assert.equal(tasks[1].parent, "auth");
	assert.equal(tasks[1].detail, "Touch src/keys.ts only.");
	assert.equal(tasks[2].level, "plan");
});

test("todo_add refuses on an act", async () => {
	await run("todo-run"); // the default queue head, "greet", is a plain act
	const result = await call("todo_add", { title: "Something else entirely", detail: "..." });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /is an act, not a plan/);
	assert.equal(store().tasks.length, 2);
});

test("a planning round closes with no model call and no test run", async () => {
	withEpic();
	await run("todo-run");
	await call("todo_add", { title: "Rotate the signing secrets", detail: "src/keys.ts" });
	await call("todo_add", { title: "Add a TOTP second factor", detail: "src/mfa.ts" });

	// Any verdict the fake model would return is the wrong answer here; the
	// round must be decided without asking it at all.
	h.verdict = '{"pass": false, "reason": "the model should never have been consulted"}';
	const result = await call("todo_complete", { summary: "two next steps" });

	assert.equal(result.terminate, true);
	assert.equal(result.isError, undefined);
	assert.equal(result.usage, undefined);
	// The round passed, but the plan reopens rather than closing: it is asked
	// again once these two have landed, with their results on disk to read.
	assert.equal(store().tasks[0].status, "todo");
	assert.match(JSON.stringify(result.content), /revisited once these are done/);
});

test("a planning round that touched the tree is rejected", async () => {
	withEpic();
	await run("todo-run");
	await call("todo_add", { title: "Rotate the signing secrets", detail: "src/keys.ts" });
	await call("todo_add", { title: "Add a TOTP second factor", detail: "src/mfa.ts" });
	writeWork(); // a plan that wrote code

	const result = await call("todo_complete", { summary: "split it and got started" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /not code/);
	assert.equal(store().tasks[0].status, "doing");
});

test("an empty first round is rejected without consulting the verifier", async () => {
	withEpic();
	await run("todo-run");
	const result = await call("todo_complete", { summary: "nothing to plan" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /first round has to produce work/);
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

test("with on_overflow = promote, an oversized failure becomes a plan", async () => {
	fs.writeFileSync(path.join(h.repo, "todoloop.toml"), `${CONFIG}\n[atomic]\non_overflow = "promote"\nmax_files = 5\n`);
	await run("todo-run");
	writeWork();
	await h.emit("session_before_compact", { preparation: { firstKeptEntryId: "e1", tokensBefore: 9000 } });

	h.verdict = '{"pass": false, "reason": "greet is still not exported"}';
	const result = await call("todo_complete", { summary: "tried" });

	assert.equal(result.terminate, true);
	const task = store().tasks[0];
	assert.equal(task.level, "plan");
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

test("a planning round carries this round's items across compaction", async () => {
	withEpic();
	await run("todo-run");
	await call("todo_add", { title: "Rotate the signing secrets", detail: "src/keys.ts" });

	const result = (await h.emit("session_before_compact", {
		preparation: { firstKeptEntryId: "e1", tokensBefore: 9000 },
	})) as { compaction: { summary: string } };

	// Without this the worker forgets what it already added and duplicates it.
	assert.match(result.compaction.summary, /added_this_round: auth\.rotate-the-signing-secrets/);
	assert.match(result.compaction.summary, /Do not re-add items/);
	assert.match(result.compaction.summary, /Write no code/);
});

test("a planning round's looking is budgeted, and the budget names the exit", async () => {
	withEpic();
	await run("todo-run");
	const look = async () =>
		((await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] })) as
			| { content: { text: string }[] }
			| undefined)?.content[0].text ?? "";

	// Default budget is 6; the first five looks pass through untouched.
	for (let i = 0; i < 5; i++) assert.equal(await look(), "", `look ${i + 1} should be free`);

	const spent = await look();
	assert.match(spent, /Looking budget spent/);
	assert.match(spent, /research act/);
	// The cut-off has to survive the model ignoring it once.
	assert.match(await look(), /Looking budget spent/);
});

test("writing items down is never charged against the looking budget", async () => {
	withEpic();
	await run("todo-run");
	for (let i = 0; i < 8; i++) {
		const out = await h.emit("tool_result", { toolName: "todo_add", content: [{ type: "text", text: "Added" }] });
		assert.equal(out, undefined, "todo tools must stay free");
	}
});

test("an act may read the repository without being metered", async () => {
	await run("todo-run");
	for (let i = 0; i < 8; i++) {
		const out = await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] });
		assert.equal(out, undefined, "acts are supposed to read the repo");
	}
});

test("under the shell driver the session defers completion instead of doing it twice", async () => {
	// `todo run` and bin/todo-loop.sh verify, commit and advance in the driver
	// process. Both sides read the same loop.running flag, so without the
	// TODOLOOP_DRIVER signal the session repeats all three: two verifier calls
	// per task, two commits, and then /todo-advance trying to replace a print
	// mode session that is already exiting.
	const saved = process.env.TODOLOOP_DRIVER;
	process.env.TODOLOOP_DRIVER = "shell";
	try {
		const shell = build();
		await shell.commands.get("todo-run")!("", shell.commandCtx);
		fs.writeFileSync(path.join(shell.repo, "greet.ts"), "export const greet = () => 'hi';\n");

		const result = await shell.tools
			.get("todo_complete")!
			.execute("id" as never, { summary: "added greet.ts" } as never, undefined as never, undefined as never, shell.ctx as never);

		assert.equal(result.terminate, true);
		assert.equal((result.details as { deferred?: boolean }).deferred, true);

		// The driver rules on it, so the session must not have closed it here.
		const current = loadStore(path.join(shell.repo, "todo.toml"));
		assert.equal(current.tasks[0].status, "doing");
		// No advance queued: there is no session for the driver's successor to replace.
		assert.deepEqual(shell.sent.filter((m) => m.text === "/todo-advance"), []);

		// The task stays "doing" until the driver rules, so agent_settled must not
		// read that as a run that ended without completing — doing so halts the
		// queue on finished work.
		for (const handler of shell.events.get("agent_start") ?? [])
			await (handler as (e: unknown, c: unknown) => Promise<void>)({}, shell.ctx);
		const settled = shell.events.get("agent_settled") ?? [];
		for (const handler of settled) await (handler as (e: unknown, c: unknown) => Promise<void>)({}, shell.ctx);
		assert.equal(loadStore(path.join(shell.repo, "todo.toml")).loop.running, true);

		// /todo-advance must be inert here: replacing the session is the driver's
		// job, done by starting a new process.
		const before = shell.newSessions.length;
		await shell.commands.get("todo-advance")!("", shell.commandCtx);
		assert.equal(shell.newSessions.length, before);
	} finally {
		if (saved === undefined) delete process.env.TODOLOOP_DRIVER;
		else process.env.TODOLOOP_DRIVER = saved;
	}
});

/** todo_read results, typed once so the assertions below stay readable. */
const readTool = async (params: Record<string, unknown>) =>
	(await call("todo_read", params)) as unknown as {
		content: { text: string }[];
		details: { count?: number };
		isError?: boolean;
	};

/**
 * The queue used to be write-only, so a worker that wanted to know what a
 * neighbouring task covered read todo.toml with awk. These pin the two bounds
 * that make the sanctioned route cheaper than that one.
 */
test("todo_read returns the assigned task in full", async () => {
	await run("todo-run");
	const result = await readTool({});
	assert.equal(result.isError, undefined);
	const text = result.content[0].text;
	assert.match(text, /greet \[code\] doing/);
	assert.match(text, /Create greet\.ts exporting greet\(name\)/, "self is the one task that carries its detail");
});

test("todo_read never hands over a neighbour's detail", async () => {
	await run("todo-run");
	const result = await readTool({ relation: "siblings" });
	const text = result.content[0].text;
	assert.match(text, /farewell \[code\] todo — Add a farewell function/);
	assert.doesNotMatch(
		text,
		/Create greet\.ts exporting/,
		"a relation listing must not carry any task's detail into the window",
	);
	assert.equal(result.details.count, 1, "siblings excludes the assigned task itself");
});

test("todo_read reports an empty relation rather than falling back to the whole queue", async () => {
	await run("todo-run");
	const result = await readTool({ relation: "children" });
	assert.match(result.content[0].text, /greet has no children/);
	assert.equal(result.details.count, 0);
});

test("todo_read caps a long relation", async () => {
	await run("todo-run");
	// Twenty siblings: more than one call should be able to spend the worker's
	// window on, however they got there.
	const file = path.join(h.repo, "todo.toml");
	const current = loadStore(file);
	for (let i = 0; i < 20; i++) {
		current.tasks.push({
			id: `extra-${i}`,
			title: `Extra ${i}`,
			status: "todo",
			attempts: 0,
			detail: "a detail nobody else should ever see",
		} as never);
	}
	saveStore(file, current);

	const result = await readTool({ relation: "siblings" });
	const text = result.content[0].text;
	assert.match(text, /more not shown/);
	assert.equal(text.split("\n").filter((line: string) => line.includes("[code]")).length, 12);
	assert.doesNotMatch(text, /nobody else should ever see/);
});

test("todo_read refuses when nothing is assigned", async () => {
	const result = await readTool({});
	assert.equal(result.isError, true);
});
