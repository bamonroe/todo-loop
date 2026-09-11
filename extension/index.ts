/**
 * todo-loop — an autonomous todo loop for pi.
 *
 * One task per session. The queue lives in todo.toml because the session is
 * replaced on every advance, so conversation-embedded state would not survive.
 * Completion is an explicit tool call that has to get past a verifier which
 * never sees the worker's own account of what it did.
 *
 *   /todo-run       start the loop
 *   /todo-stop      stop after the current task
 *   /todo-status    show the queue
 *   /todo-advance   internal: archive and start the next task
 *
 * Load with:  pi -e /path/to/todo-loop/extension/index.ts
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_CONFIG, loadConfig, splitModelRef, type Config } from "../src/config.ts";
import {
	changedFiles,
	commitAll,
	gatherEvidence,
	headCommit,
	isGitRepo,
	isTreeClean,
	truncateTail,
} from "../src/evidence.ts";
import { renderPinnedTask, renderTaskPrompt } from "../src/prompt.ts";
import {
	counts,
	findTask,
	loadStore,
	markBlocked,
	markDoing,
	markDone,
	nextLeaf,
	recordFailure,
	renderTree,
	resolveStorePath,
	saveStore,
	type Store,
	type Task,
} from "../src/store.ts";
import { ollamaCompleter, verify, type Completer, type Verdict } from "../src/verify.ts";

/** Tools whose output is bulky enough to be worth capping before it enters context. */
const BULKY_TOOLS = new Set(["bash", "grep", "rg", "glob", "list", "read", "web_fetch"]);

interface TextBlock {
	type: string;
	text?: string;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return (content as TextBlock[])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();
	let config: Config = DEFAULT_CONFIG;
	let storeFile = "";
	let initialised = false;

	/** Did an agent run actually happen in this session? Guards the silent-stop check. */
	let sawAgentStart = false;
	/** Usage from the most recent nested verifier call, reported back on the tool result. */
	let lastVerifierUsage: Usage | undefined;
	let spillDir: string | undefined;

	const init = (ctx: ExtensionContext): void => {
		if (initialised) return;
		cwd = ctx.cwd ?? process.cwd();
		config = loadConfig(cwd);
		storeFile = resolveStorePath(cwd);
		initialised = true;
	};

	const read = (): Store => loadStore(storeFile);
	const write = (store: Store): void => saveStore(storeFile, store);

	const say = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else console.log(`[todo-loop] ${message}`);
	};

	const activeTask = (store: Store): Task | undefined =>
		store.loop.current ? findTask(store, store.loop.current) : undefined;

	/**
	 * The verifier runs as a nested call inside the tool, not as its own session.
	 * That keeps the worker's context alive for the retry case — on a rejection
	 * we want it to continue where it is, not start cold.
	 */
	const verifierFor = (ctx: ExtensionContext, signal?: AbortSignal): Completer => {
		const { provider, model: modelId } = splitModelRef(config.models.verifier);
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			return ollamaCompleter(config.ollama.base_url, modelId, signal);
		}
		return async ({ system, user }) => {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: system,
					messages: [{ role: "user" as const, content: [{ type: "text" as const, text: user }], timestamp: Date.now() }],
				},
				{ maxTokens: 1024, signal, cacheRetention: "none", sessionId: uuidv7() },
			);
			lastVerifierUsage = response.usage;
			return response.content
				.filter((block: TextBlock) => block.type === "text")
				.map((block: TextBlock) => block.text ?? "")
				.join("\n");
		};
	};

	const runVerification = async (ctx: ExtensionContext, task: Task, baseCommit: string): Promise<Verdict> => {
		if (!config.verify.enabled) return { pass: true, reason: "Verification disabled.", mechanical: true };
		const evidence = await gatherEvidence({
			cwd,
			baseCommit,
			testCommand: config.verify.test_command,
			buildCommand: config.verify.build_command,
			requireTestsPass: config.verify.require_tests_pass,
			timeoutMs: config.verify.timeout_ms,
			maxBytes: config.verify.max_evidence_bytes,
		});
		return verify(task, evidence, verifierFor(ctx, ctx.signal));
	};

	const checkpoint = async (task: Task, summary: string): Promise<void> => {
		if (config.loop.checkpoint !== "commit") return;
		if (!(await isGitRepo(cwd))) return;
		await commitAll(cwd, `${config.loop.commit_prefix}(${task.id}): ${summary || task.title}`);
	};

	/**
	 * Claim the next leaf and hand it to a fresh session.
	 *
	 * Only leaves are ever prompted. A parent's task is its children, and
	 * handing the model an interior node is how you get a forty-turn run.
	 */
	const startNext = async (ctx: ExtensionCommandContext): Promise<void> => {
		const store = read();
		if (!store.loop.running) return;

		if (store.loop.iterations >= config.loop.max_iterations) {
			store.loop.running = false;
			write(store);
			say(ctx, `Stopped at the ${config.loop.max_iterations}-iteration cap.`, "warning");
			return;
		}

		const task = nextLeaf(store);
		if (!task) {
			store.loop.running = false;
			store.loop.current = "";
			write(store);
			const stats = counts(store);
			say(ctx, `Queue empty — ${stats.done} done, ${stats.blocked} blocked.`);
			return;
		}

		if (config.loop.checkpoint === "require-clean" && !(await isTreeClean(cwd))) {
			store.loop.running = false;
			write(store);
			say(ctx, "Working tree is dirty and checkpoint = require-clean. Commit or stash, then /todo-run.", "error");
			return;
		}

		markDoing(store, task, await headCommit(cwd));
		store.loop.iterations += 1;
		write(store);

		// Everything the replacement session needs must be plain data captured
		// before the switch — the old pi and ctx throw once the session is gone.
		const kickoff = renderTaskPrompt(store, task, {
			mode: "tool",
			lastFailure: store.loop.last_failure,
			attempts: task.attempts,
			maxAttempts: config.verify.max_attempts,
		});

		await ctx.newSession({
			withSession: async (fresh) => {
				await fresh.sendUserMessage(kickoff);
			},
		});
	};

	// ---------------------------------------------------------------- commands

	pi.registerCommand("todo-run", {
		description: "Work todo.toml until the queue is empty",
		handler: async (args, ctx) => {
			init(ctx);
			const store = read();
			if (!nextLeaf(store)) {
				say(ctx, "Nothing to do — no incomplete leaf tasks.", "warning");
				return;
			}
			store.loop.running = true;
			store.loop.iterations = 0;
			if (args.trim() === "--fresh") store.loop.last_failure = "";
			write(store);
			await startNext(ctx);
		},
	});

	pi.registerCommand("todo-advance", {
		description: "Internal: start the next task in a fresh session",
		handler: async (_args, ctx) => {
			init(ctx);
			if (!read().loop.running) return;
			await ctx.waitForIdle();
			await startNext(ctx);
		},
	});

	pi.registerCommand("todo-stop", {
		description: "Stop the todo loop",
		handler: async (_args, ctx) => {
			init(ctx);
			const store = read();
			store.loop.running = false;
			write(store);
			say(ctx, "Loop stopped. The current task keeps its progress.");
		},
	});

	pi.registerCommand("todo-status", {
		description: "Show the todo queue",
		handler: async (_args, ctx) => {
			init(ctx);
			const store = read();
			const stats = counts(store);
			const lines = [
				renderTree(store) || "(no tasks)",
				"",
				`${stats.done} done · ${stats.todo} todo · ${stats.doing} in progress · ${stats.blocked} blocked`,
				`loop ${store.loop.running ? "running" : "stopped"} · iteration ${store.loop.iterations}` +
					(store.loop.current ? ` · current ${store.loop.current}` : ""),
			];
			if (store.loop.last_failure) lines.push(`last failure: ${store.loop.last_failure}`);
			say(ctx, lines.join("\n"));
		},
	});

	// ------------------------------------------------------------------- tools

	pi.registerTool({
		name: "todo_complete",
		label: "Complete Todo",
		description:
			"Mark the assigned task complete. Only call this when the work is actually finished — the change is verified against the diff and the test output before it is accepted.",
		promptSnippet: "Call todo_complete when the assigned task is done.",
		parameters: Type.Object({
			summary: Type.String({ description: "One line describing what changed." }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			init(ctx);
			const store = read();
			const task = activeTask(store);
			if (!task) {
				return {
					content: [{ type: "text", text: "No task is currently assigned; nothing to complete." }],
					details: {},
					isError: true,
				};
			}

			lastVerifierUsage = undefined;
			const verdict = await runVerification(ctx, task, store.loop.base_commit);
			const usage = lastVerifierUsage;

			if (verdict.pass) {
				markDone(store, task, params.summary || verdict.reason);
				write(store);
				await checkpoint(task, params.summary);
				// A tool cannot replace the session itself, so queue the command that can.
				pi.sendUserMessage("/todo-advance", { deliverAs: "followUp", expandPromptTemplates: true });
				return {
					content: [{ type: "text", text: `Verified and closed ${task.id}. Moving to the next task.` }],
					details: { taskId: task.id, verdict },
					usage,
					terminate: true,
				};
			}

			const attempts = recordFailure(store, task, verdict.reason);
			if (attempts >= config.verify.max_attempts) {
				markBlocked(store, task, `Blocked after ${attempts} attempts: ${verdict.reason}`);
				write(store);
				say(ctx, `${task.id} blocked after ${attempts} attempts: ${verdict.reason}`, "error");
				return {
					content: [{ type: "text", text: `Blocked after ${attempts} attempts: ${verdict.reason}` }],
					details: { taskId: task.id, verdict, attempts },
					usage,
					isError: true,
					terminate: true,
				};
			}

			write(store);
			// No terminate: the result lands in context and the worker picks up
			// from here. Nothing has to be injected to resume it.
			return {
				content: [
					{
						type: "text",
						text: `Not complete (attempt ${attempts} of ${config.verify.max_attempts}).\n\n${verdict.reason}\n\nAddress exactly what is missing, then call todo_complete again.`,
					},
				],
				details: { taskId: task.id, verdict, attempts },
				usage,
				isError: true,
			};
		},
	});

	pi.registerTool({
		name: "todo_block",
		label: "Block Todo",
		description:
			"Declare the assigned task impossible as written — missing information, a broken precondition, or a contradiction. This halts the loop for a human.",
		promptSnippet: "Call todo_block if the assigned task cannot be done as written.",
		parameters: Type.Object({
			reason: Type.String({ description: "What makes this task impossible as written." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			init(ctx);
			const store = read();
			const task = activeTask(store);
			if (!task) {
				return { content: [{ type: "text", text: "No task is currently assigned." }], details: {}, isError: true };
			}
			markBlocked(store, task, params.reason);
			write(store);
			say(ctx, `${task.id} blocked: ${params.reason}`, "warning");
			return {
				content: [{ type: "text", text: `Blocked ${task.id}. The loop has stopped.` }],
				details: { taskId: task.id, reason: params.reason },
				terminate: true,
			};
		},
	});

	// ------------------------------------------------------------------ events

	pi.on("session_start", async (_event, ctx) => {
		init(ctx);
		const store = read();
		if (store.loop.running && store.loop.current) {
			say(ctx, `todo-loop: working ${store.loop.current} (iteration ${store.loop.iterations}).`);
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		init(ctx);
		sawAgentStart = true;
	});

	/**
	 * Pin the task into the system prompt rather than leaving it as the first
	 * user message. Context surgery can then never lose the one thing the
	 * worker must not forget.
	 */
	pi.on("before_agent_start", async (event, ctx) => {
		init(ctx);
		const store = read();
		if (!store.loop.running) return;
		const task = activeTask(store);
		if (!task) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${renderPinnedTask(store, task, store.loop.last_failure)}` };
	});

	/**
	 * Elide old tool results once context gets tight.
	 *
	 * Batched deliberately: llama.cpp and Ollama reuse the KV cache only across
	 * a matching prefix, so rewriting the middle of the history forces a
	 * recompute of everything after the edit. Trimming a little every turn
	 * means near-full prefill every turn. One big edit at a threshold does not.
	 */
	pi.on("context", async (event, ctx) => {
		init(ctx);
		if (!read().loop.running) return;

		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? ctx.model?.contextWindow;
		if (!usage || !window || usage.tokens === null) return;
		if (usage.tokens < window * config.context.prune_at_fraction) return;

		const messages = event.messages as { role?: string; toolName?: string; content?: unknown }[];
		let seenAssistant = 0;
		let cutoff = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "assistant") {
				seenAssistant += 1;
				if (seenAssistant >= config.context.keep_full_turns) {
					cutoff = i;
					break;
				}
			}
		}
		if (cutoff <= 0) return;

		let elided = 0;
		for (let i = 0; i < cutoff; i++) {
			const message = messages[i];
			if (message.role !== "toolResult") continue;
			const size = JSON.stringify(message.content ?? "").length;
			if (size < config.context.stub_min_bytes) continue;
			message.content = [
				{
					type: "text",
					text: `[${message.toolName ?? "tool"} result elided — ${size} bytes. Re-run the tool if you need it again.]`,
				},
			];
			elided += 1;
		}

		if (!elided) return;
		return { messages: event.messages };
	});

	/**
	 * Pi's built-in cap is 50KB / 2000 lines — far too generous for a 27B.
	 * The full text goes to a temp file so nothing is actually lost.
	 */
	pi.on("tool_result", async (event, ctx) => {
		init(ctx);
		if (!read().loop.running) return;
		if (!BULKY_TOOLS.has(event.toolName)) return;

		const text = textOf(event.content);
		const max = config.context.tool_output_max_bytes;
		if (!text || Buffer.byteLength(text, "utf8") <= max) return;

		spillDir = spillDir ?? mkdtempSync(join(tmpdir(), "todo-loop-"));
		const file = join(spillDir, `${event.toolName}-${Date.now()}.txt`);
		try {
			writeFileSync(file, text);
		} catch {
			return;
		}

		return {
			content: [
				{
					type: "text",
					text: `${truncateTail(text, max)}\n\n[output capped at ${max} bytes; full text at ${file}]`,
				},
			],
		};
	});

	/**
	 * Fields, not prose. A prose summary loses exactly the details a weak model
	 * needs in order to resume.
	 */
	pi.on("session_before_compact", async (event, ctx) => {
		init(ctx);
		const store = read();
		if (!store.loop.running) return;
		const task = activeTask(store);
		if (!task) return;

		const files = await changedFiles(cwd, store.loop.base_commit);
		const summary = [
			"# Task state carried across compaction",
			`task:          ${task.id}: ${task.title}`,
			task.detail ? `detail:        ${task.detail.trim().replace(/\n/g, "\n               ")}` : "",
			`attempt:       ${task.attempts + 1} of ${config.verify.max_attempts}`,
			`files_touched: ${files.length ? files.join(", ") : "(none yet)"}`,
			`last_failure:  ${store.loop.last_failure || "(none)"}`,
			"",
			"Finish by calling todo_complete. Re-read any file you need; the exploration that got you here is gone.",
		]
			.filter(Boolean)
			.join("\n");

		return {
			compaction: {
				summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	});

	/**
	 * Never infer completion from "the agent stopped talking". A run that ends
	 * without todo_complete is a failure, not an advance.
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		init(ctx);
		if (!sawAgentStart) return;

		const store = read();
		if (!store.loop.running) return;
		const task = activeTask(store);
		if (!task) return;

		const note = "Run ended without calling todo_complete.";
		if (config.loop.on_silent_stop === "retry") {
			const attempts = recordFailure(store, task, note);
			if (attempts >= config.verify.max_attempts) {
				markBlocked(store, task, `Blocked after ${attempts} attempts: ${note}`);
				write(store);
				say(ctx, `${task.id} blocked: ${note}`, "error");
				return;
			}
			write(store);
			say(ctx, `${task.id} stopped without completing; retrying (attempt ${attempts + 1}).`, "warning");
			pi.sendUserMessage("/todo-advance", { deliverAs: "followUp", expandPromptTemplates: true });
			return;
		}

		store.loop.running = false;
		write(store);
		say(ctx, `Loop halted: ${task.id} ended without calling todo_complete.`, "error");
	});
}
