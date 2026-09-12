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
import { renderAssignmentPrompt, renderPinnedTask } from "../src/prompt.ts";
import {
	allowedChildLevels,
	assignmentFor,
	childrenOf,
	counts,
	findTask,
	insertChildren,
	levelOf,
	loadStore,
	markBlocked,
	markDoing,
	markDone,
	markOverflow,
	nextLeaf,
	promoteToScope,
	recordFailure,
	renderTree,
	resolveStorePath,
	saveStore,
	type Store,
	type Task,
	type TaskLevel,
} from "../src/store.ts";
import { checkDecomposition } from "../src/decompose.ts";
import { completerFor } from "../src/providers.ts";
import { verify, type Completer, type Verdict } from "../src/verify.ts";

/** Tools whose output is bulky enough to be worth capping before it enters context. */
const BULKY_TOOLS = new Set(["bash", "grep", "rg", "glob", "list", "read", "web_fetch"]);

interface TextBlock {
	type: string;
	text?: string;
}

/** Ids come from titles so a weak model never has to invent one. */
function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.slice(0, 6)
		.join("-");
	return slug || "task";
}

/**
 * Namespace a child under its parent and make it unique.
 *
 * Duplicate ids make leaf selection ambiguous — doctor calls that a hard failure
 * — so a collision is resolved here rather than written into the queue.
 */
function uniqueId(store: Store, base: string, parentId: string): string {
	const prefixed = base.startsWith(`${parentId}.`) ? base : `${parentId}.${base}`;
	if (!store.tasks.some((task) => task.id === prefixed)) return prefixed;
	for (let n = 2; ; n++) {
		const candidate = `${prefixed}-${n}`;
		if (!store.tasks.some((task) => task.id === candidate)) return candidate;
	}
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
	/**
	 * Did compaction fire while working the current task? The strongest available
	 * signal that a task was not atomic — the worker ran out of room inside work
	 * that was supposed to fit in one session. Reset on every advance.
	 */
	let compactedThisTask = false;
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
			// pi does not know this model, or has no credentials for it. Fall back to
			// talking to the provider directly rather than silently skipping the check.
			return completerFor(config.models.verifier, config, signal);
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
		const store = read();
		const decomposing = assignmentFor(task) === "decompose";

		const evidence = await gatherEvidence({
			cwd,
			baseCommit,
			// A breakdown runs no build and no tests: it changed no code, so there is
			// nothing to build, and paying for a full test run to confirm that would
			// be the most expensive way to learn nothing.
			testCommand: decomposing ? "" : config.verify.test_command,
			buildCommand: decomposing ? "" : config.verify.build_command,
			requireTestsPass: decomposing ? false : config.verify.require_tests_pass,
			timeoutMs: config.verify.timeout_ms,
			maxBytes: config.verify.max_evidence_bytes,
		});

		// A breakdown is judged entirely by tooling — no model, no network, no cost.
		if (decomposing) return checkDecomposition(store, task, evidence.files, config);

		if (!config.verify.enabled) return { pass: true, reason: "Verification disabled.", mechanical: true };
		noteOverflow(task, evidence.files);
		return verify(task, evidence, verifierFor(ctx, ctx.signal));
	};

	/**
	 * Flag a leaf that overran its context budget — too many files, or compaction
	 * firing inside a single task. Never a failure on its own: the work may be
	 * right, and only the size is in question.
	 */
	const noteOverflow = (task: Task, files: string[]): void => {
		if (config.atomic.on_overflow === "off") return;
		if (compactedThisTask && !task.overflowed) {
			markOverflow(task, "context compaction fired inside a single task");
			return;
		}
		if (files.length > config.atomic.max_files) {
			markOverflow(task, `touched ${files.length} files (budget ${config.atomic.max_files})`);
		}
	};

	// Subject stays short and scannable; the worker's summary goes in the body.
	const checkpoint = async (task: Task, body: string): Promise<void> => {
		if (config.loop.checkpoint !== "commit") return;
		if (!(await isGitRepo(cwd))) return;
		const subject = `${config.loop.commit_prefix}(${task.id}): ${task.title}`;
		await commitAll(cwd, body.trim() ? `${subject}\n\n${body.trim()}` : subject);
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
		const kickoff = renderAssignmentPrompt(store, task, {
			mode: "tool",
			lastFailure: store.loop.last_failure,
			attempts: task.attempts,
			maxAttempts: config.verify.max_attempts,
			maxFiles: config.atomic.max_files,
			minChildren: config.decompose.min_children,
		});

		// A fresh session is a fresh budget; the previous task's overflow must not
		// follow this one.
		compactedThisTask = false;

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
				`${stats.done} done · ${stats.todo} todo · ${stats.doing} in progress · ${stats.blocked} blocked` +
					(stats.pending_breakdowns ? ` · ${stats.pending_breakdowns} awaiting breakdown` : ""),
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
				const overflowNote = task.overflowed ? ` (note: ${task.overflow_reason} — this task was larger than one task should be)` : "";
				markDone(store, task, params.summary || verdict.reason);
				write(store);
				await checkpoint(task, params.summary);
				// A tool cannot replace the session itself, so queue the command that can.
				pi.sendUserMessage("/todo-advance", { deliverAs: "followUp", expandPromptTemplates: true });
				return {
					content: [{ type: "text", text: `Verified and closed ${task.id}.${overflowNote} Moving to the next task.` }],
					details: { taskId: task.id, verdict },
					usage,
					terminate: true,
				};
			}

			const attempts = recordFailure(store, task, verdict.reason);

			// Failed *and* over budget is much more likely to be a task that was
			// never atomic than a worker that nearly got there. Break it down
			// instead of spending two more attempts proving the same point.
			if (
				config.atomic.on_overflow === "promote" &&
				task.overflowed &&
				levelOf(task) === "task" &&
				assignmentFor(task) === "implement"
			) {
				promoteToScope(store, task, `Promoted to scope: ${task.overflow_reason ?? "over budget"}`);
				write(store);
				say(ctx, `${task.id} was too coarse (${task.overflow_reason}); it will be broken down instead.`, "warning");
				pi.sendUserMessage("/todo-advance", { deliverAs: "followUp", expandPromptTemplates: true });
				return {
					content: [
						{
							type: "text",
							text: `${task.id} is too large to be one task (${task.overflow_reason}). It has been turned into a scope and will be broken down next.`,
						},
					],
					details: { taskId: task.id, verdict, promoted: true },
					usage,
					terminate: true,
				};
			}

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

	/**
	 * The only way a scope or an epic produces anything. Children are inserted
	 * beside their parent rather than appended, so the loop stays depth-first.
	 */
	pi.registerTool({
		name: "todo_add",
		label: "Add Todo",
		description:
			"Add a child item under the scope or epic currently being broken down. Call once per child. Only use this while working a breakdown.",
		promptSnippet: "While breaking down a scope or epic, add each child with todo_add.",
		parameters: Type.Object({
			title: Type.String({ description: "One line naming the work. Must stand on its own." }),
			detail: Type.String({
				description:
					"Everything the worker will need: files, function names, formats, constraints. This is the only context that task will ever have.",
			}),
			level: Type.Optional(
				Type.Union([Type.Literal("task"), Type.Literal("scope")], {
					description: "task = atomic and implementable now. scope = still needs investigation before it can be split.",
				}),
			),
			id: Type.Optional(Type.String({ description: "Explicit id. Defaults to a slug of the title." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			init(ctx);
			const store = read();
			const parent = activeTask(store);
			if (!parent) {
				return {
					content: [{ type: "text", text: "No task is currently assigned; nothing to add children to." }],
					details: {},
					isError: true,
				};
			}
			if (assignmentFor(parent) !== "decompose") {
				return {
					content: [
						{
							type: "text",
							text: `${parent.id} is a task, not a breakdown. Implement it rather than splitting it. If it is genuinely too large, call todo_block and say so.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const level = (params.level ?? "task") as TaskLevel;
			const allowed = allowedChildLevels(levelOf(parent));
			if (!allowed.includes(level)) {
				return {
					content: [
						{ type: "text", text: `A ${levelOf(parent)} may only spawn ${allowed.join(" or ")}; got ${level}.` },
					],
					details: {},
					isError: true,
				};
			}

			const id = uniqueId(store, params.id?.trim() || slugify(params.title), parent.id);
			const child: Task = {
				id,
				title: params.title.trim(),
				status: "todo",
				attempts: 0,
				parent: parent.id,
			};
			if (params.detail.trim()) child.detail = params.detail.trim();
			if (level !== "task") child.level = level;

			insertChildren(store, parent.id, [child]);
			write(store);

			const total = childrenOf(parent.id, store.tasks).length;
			return {
				content: [{ type: "text", text: `Added ${id} [${level}] under ${parent.id} (${total} so far).` }],
				details: { taskId: id, parent: parent.id, level },
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

		// Compaction inside a single task is the loudest evidence available that
		// the task did not fit. Record it here, where it actually happens, and act
		// on it at verification time.
		compactedThisTask = true;

		const files = await changedFiles(cwd, store.loop.base_commit);
		const decomposing = assignmentFor(task) === "decompose";
		const summary = [
			"# Task state carried across compaction",
			`task:          ${task.id} [${levelOf(task)}]: ${task.title}`,
			decomposing
				? "job:           break this down into child tasks with todo_add. Write no code."
				: "",
			task.detail ? `detail:        ${task.detail.trim().replace(/\n/g, "\n               ")}` : "",
			`attempt:       ${task.attempts + 1} of ${config.verify.max_attempts}`,
			decomposing
				? `children_added: ${
						childrenOf(task.id, store.tasks)
							.map((child) => `${child.id} [${levelOf(child)}]`)
							.join(", ") || "(none yet)"
					}`
				: `files_touched: ${files.length ? files.join(", ") : "(none yet)"}`,
			`last_failure:  ${store.loop.last_failure || "(none)"}`,
			"",
			decomposing
				? "Do not re-add children that are already listed above. Finish by calling todo_complete."
				: "Finish by calling todo_complete. Re-read any file you need; the exploration that got you here is gone.",
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
