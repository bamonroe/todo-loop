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

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { childEnv, DEFAULT_CONFIG, inheritsWorker, loadConfig, splitModelRef, type Config } from "../src/config.ts";
import {
	changedFiles,
	commitAll,
	evidenceFilePath,
	gatherEvidence,
	headCommit,
	isGitRepo,
	isTreeClean,
	loopOwnedPaths,
	truncateMiddle,
	truncateTail,
} from "../src/evidence.ts";
import { renderAssignmentPrompt, renderPinnedTask } from "../src/prompt.ts";
import {
	type ActKind,
	allowedChildLevels,
	assignmentFor,
	depthOf,
	kindOf,
	childrenOf,
	counts,
	createTask,
	findTask,
	insertChildren,
	levelOf,
	loadStore,
	markBlocked,
	markDoing,
	markDone,
	markOverflow,
	nextReady,
	parentOf,
	fileBudgetOf,
	isPromotable,
	promoteToPlan,
	researchBudgetOf,
	unfinishedChildren,
	recordFailure,
	renderTree,
	resolveStorePath,
	saveStore,
	type Store,
	type Task,
	type TaskLevel,
} from "../src/store.ts";
import { checkPlanRound, nearDuplicate, type PlanVerdict } from "../src/plan.ts";

/**
 * The most a single todo_read relation may return. A breakdown of thirty
 * children is legal; spending the worker's window on the list of them is not.
 */
const TODO_READ_MAX_ROWS = 12;
import { completerFor } from "../src/providers.ts";
import { verify, type Completer, type Verdict } from "../src/verify.ts";

/** Tools whose output is bulky enough to be worth capping before it enters context. */
const BULKY_TOOLS = new Set(["bash", "grep", "rg", "glob", "list", "read", "web_fetch"]);

/**
 * How to split the budget between the two ends when a result is too big.
 *
 * Command output earns its verdict at the end — the exit line, the stack
 * trace, the last failing assertion — so `bash` spends most of its budget
 * there. Everything else here is a document read from the top: a file, a
 * directory listing, a match list. Keeping *their* tail hands the model the
 * last few KB of a file and none of its beginning, which is how a run-4
 * planner read NOTES.md three times and still never saw the top of it.
 *
 * Neither end is given the whole budget any more. A worker in run 13 said out
 * loud that "earlier greps were being head-truncated by the harness" while
 * hunting through `javap`, which puts what it was looking for at the head and
 * went through `bash`. One rule per tool cannot be right for both, and a
 * quarter of a budget is cheaper than the turn it takes to re-run a command.
 */
const HEAD_SHARE = new Map([["bash", 0.25]]);
const DEFAULT_HEAD_SHARE = 0.75;

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

	/**
	 * True when this session was spawned by the shell driver (`todo run` or
	 * bin/todo-loop.sh), which sets TODOLOOP_DRIVER=shell.
	 *
	 * Both drivers read the same `loop.running` flag, so without this the
	 * extension tries to drive a loop the driver is already driving: the task is
	 * verified twice and committed twice, and `/todo-advance` then attempts to
	 * replace a print mode session, which throws a stale-context error. One loop,
	 * one owner.
	 */
	const shellDriven = process.env.TODOLOOP_DRIVER === "shell";

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
	let evidenceFile: string | undefined;

	/**
	 * Where results from `verify.evidence_tools` are written for the verifier.
	 *
	 * Under the shell driver the path comes from the environment, because the
	 * driver has to read the file after this session has exited and it truncates
	 * it before every attempt — so a rejected attempt's evidence never props up
	 * the next one. In-session verification has no such handoff and picks its own
	 * path. Deliberately outside the repository: `commitAll` is `git add -A`, and
	 * evidence about a task has no business being committed as part of it.
	 */
	const evidencePath = (): string => {
		evidenceFile = evidenceFile ?? process.env.TODOLOOP_EVIDENCE_FILE ?? evidenceFilePath(cwd);
		return evidenceFile;
	};

	/**
	 * Record a tool result the verifier would otherwise never see.
	 *
	 * Appended as it happens rather than gathered at the end: the worker may call
	 * a tool several times, and the run that mattered is not always the last one.
	 * Capped per entry for the same reason every other channel is — the verifier
	 * reads this, and an unbounded lint report would crowd out the diff.
	 *
	 * The cap is a share of the verifier's evidence budget and not the worker's
	 * context cap, which is a different budget under different pressure: raising
	 * what the worker may read has no business letting one lint report eat most
	 * of what the judge gets to see.
	 */
	const recordEvidence = (toolName: string, text: string | undefined): void => {
		if (!text || !config.verify.evidence_tools.includes(toolName)) return;
		try {
			appendFileSync(
				evidencePath(),
				`### ${toolName}\n${truncateTail(text, Math.floor(config.verify.max_evidence_bytes / 4))}\n\n`,
			);
		} catch {
			// A verifier that sees less evidence is a worse verifier, not a broken
			// one. Never fail the worker's tool call over the bookkeeping.
		}
	};
	/** Inspection calls this planning round has spent, and whose round they belong to. */
	let looks = { taskId: "", count: 0 };

	const init = (ctx: ExtensionContext): void => {
		if (initialised) return;
		cwd = ctx.cwd ?? process.cwd();
		config = loadConfig(cwd);
		storeFile = resolveStorePath(cwd);
		initialised = true;
	};

	const read = (): Store => loadStore(storeFile);
	const write = (store: Store): void => saveStore(storeFile, store);
	/** The files the loop writes: out of the verifier's diff, and out of the dirty check. */
	const ownedPaths = (store: Store): string[] =>
		loopOwnedPaths(cwd, [storeFile, store.archive?.file, store.sidecarFile]);

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
		const planning = assignmentFor(task) === "plan";

		const evidence = await gatherEvidence({
			cwd,
			baseCommit,
			// A planning round runs no build and no tests: it changed no code, so
			// there is nothing to build, and paying for a full test run to confirm
			// that would be the most expensive way to learn nothing.
			testCommand: planning ? "" : config.verify.test_command,
			buildCommand: planning ? "" : config.verify.build_command,
			requireTestsPass: planning ? false : config.verify.require_tests_pass,
			timeoutMs: config.verify.timeout_ms,
			maxBytes: config.verify.max_evidence_bytes,
			maxDiffBytes: config.verify.max_diff_bytes,
			exclude: ownedPaths(store),
			// Only set once a recorded tool has actually run, so a session that
			// called none reads no file at all.
			evidenceFile,
			// In-session this mostly re-applies what the driver already put in
			// our own environment. It matters for the in-session loop shape,
			// where there is no driver above us to have applied anything.
			env: childEnv(config),
		});

		// A round is judged entirely by tooling — no model, no network, no cost.
		if (planning) return checkPlanRound(store, task, evidence.files, config);

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
		const budget = fileBudgetOf(task, config.atomic.max_files);
		if (files.length > budget) {
			markOverflow(task, `touched ${files.length} files (${task.max_files ? "its own budget" : "budget"} ${budget})`);
		}
	};

	// Subject stays short and scannable; the worker's summary goes in the body.
	const checkpoint = async (task: Task, body: string): Promise<void> => {
		// See the ladder in src/config.ts: everything above "off" commits.
		if (config.loop.checkpoint === "off") return;
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

		const task = nextReady(store);
		if (!task) {
			store.loop.running = false;
			store.loop.current = "";
			write(store);
			const stats = counts(store);
			say(ctx, `Queue empty — ${stats.done} done, ${stats.blocked} blocked.`);
			return;
		}

		if (config.loop.checkpoint === "require-clean" && !(await isTreeClean(cwd, ownedPaths(store)))) {
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
			rejections: task.rejections,
			attempts: task.attempts,
			maxAttempts: config.verify.max_attempts,
			maxFiles: fileBudgetOf(task, config.atomic.max_files),
			maxChildren: config.plan.max_children,
			researchBudget: researchBudgetOf(task, config.plan.research_budget),
			lookBudget: config.plan.look_budget,
			maxDepth: config.plan.max_depth,
			memoryFile: config.plan.memory_file,
			buildCommand: config.verify.build_command,
			workerCheck: config.verify.worker_check,
			workerTools: config.project.worker_tools,
			// Never set by this driver — it has no worker to kill — but a task row
			// can carry them in from a shell-driver run that was stopped, and the
			// retry deserves them whichever driver picks it up.
			interruptedThinking: task.interrupted_thinking,
			carriedWork: store.loop.carried === task.id,
			testCommand: config.verify.test_command,
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

	/**
	 * In-session the worker is the session's own model — the loop replaces the
	 * session on every advance, and the replacement takes pi's configured model,
	 * not this extension's. So `models.worker` is a shell-driver setting here.
	 *
	 * Saying so once at the start beats letting a queue run overnight on a model
	 * the config claims it is not using.
	 */
	const noteWorkerModel = (ctx: ExtensionContext): void => {
		if (inheritsWorker(config)) return;
		const want = splitModelRef(config.models.worker);
		const active = ctx.model;
		if (active && active.provider === want.provider && active.id === want.model) return;
		const running = active ? `${active.provider}/${active.id}` : "the session's model";
		say(
			ctx,
			`models.worker is ${config.models.worker}, but in-session the loop runs on ${running}. ` +
				"Switch with /model, or ignore this — models.worker only binds the shell driver.",
			"warning",
		);
	};

	pi.registerCommand("todo-run", {
		description: "Work todo.toml until the queue is empty",
		handler: async (args, ctx) => {
			init(ctx);
			const store = read();
			if (!nextReady(store)) {
				say(ctx, "Nothing to do — no incomplete leaf tasks.", "warning");
				return;
			}
			noteWorkerModel(ctx);
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
			// The shell driver advances by starting a new process, so there is no
			// session for this to replace — attempting it throws a stale-context
			// error once the print mode session is on its way out.
			if (shellDriven) return;
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

			// The shell driver owns the loop: it verifies, checkpoints and starts
			// the next task in a new process. Doing any of that here as well would
			// verify every task twice — two metered calls per task on a hosted
			// verifier — commit it twice, and then fail trying to replace a print
			// mode session that is about to exit anyway. Record the claim and let
			// the driver rule on it.
			if (shellDriven) {
				return {
					content: [
						{
							type: "text",
							text: `Recorded ${task.id} as finished. The loop driver verifies it against the diff and the test output after this session exits.`,
						},
					],
					details: { taskId: task.id, deferred: true },
					terminate: true,
				};
			}

			lastVerifierUsage = undefined;
			const verdict = await runVerification(ctx, task, store.loop.base_commit);
			const usage = lastVerifierUsage;

			if (verdict.pass) {
				const overflowNote = task.overflowed ? ` (note: ${task.overflow_reason} — this task was larger than one task should be)` : "";
				const plan = assignmentFor(task) === "plan" ? (verdict as PlanVerdict) : undefined;
				if (plan?.spentResearch) {
					task.research_budget = Math.max(0, researchBudgetOf(task, config.plan.research_budget) - 1);
				}
				// A plan reopens rather than closing: it is asked again once this
				// batch has landed, with the results on disk to decide against. Only
				// a round that adds nothing finishes it.
				if (plan && !plan.finished) {
					task.status = "todo";
					task.attempts = 0;
					task.rejections = undefined;
					if (store.loop.current === task.id) store.loop.current = "";
					store.loop.last_failure = "";
					write(store);
					await checkpoint(task, params.summary);
					pi.sendUserMessage("/todo-advance", { deliverAs: "followUp", expandPromptTemplates: true });
					return {
						content: [{ type: "text", text: `${verdict.reason} ${task.id} stays open and is revisited once these are done.` }],
						details: { taskId: task.id, verdict },
						usage,
						terminate: true,
					};
				}
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
			if (config.atomic.on_overflow === "promote" && task.overflowed && isPromotable(task)) {
				promoteToPlan(store, task, `Promoted to plan: ${task.overflow_reason ?? "over budget"}`);
				task.research_budget = researchBudgetOf(task, config.plan.research_budget);
				write(store);
				say(ctx, `${task.id} was too coarse (${task.overflow_reason}); its next steps get decided instead.`, "warning");
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
	 * The queue was write-only before this: todo_add, todo_block and
	 * todo_complete, with no way to look at anything. A worker that wants to know
	 * whether a neighbouring task already covers something therefore reaches for
	 * the file — observed in the wild as `awk '/id = "eq.add-system/...' todo.toml`
	 * — which costs tokens to compose, tokens to read back, and lands whole
	 * sibling details in a window that cannot afford them.
	 *
	 * Two bounds, because constraining the relation alone does not constrain the
	 * context. The expensive axis is `detail`: the eight siblings in one real
	 * breakdown carried two to three hundred words each, so a relation that
	 * returned full records would pull more into the window than the awk it
	 * replaces, and would feel sanctioned while doing it.
	 *
	 *   1. Only self, parent, children, siblings — never the whole queue.
	 *   2. Only self carries `detail`. Everyone else is id, title, status, level.
	 *
	 * "Nobody's detail but your own" is enforced here rather than requested in the
	 * prompt, because a rule a small model has to remember under context pressure
	 * is a rule that breaks exactly when it matters.
	 */
	pi.registerTool({
		name: "todo_read",
		label: "Read Todo",
		description:
			"Look at the assigned task, or list its parent, children or siblings. Relations return titles and status only. Use it to orient, or to check for a duplicate before todo_add.",
		promptSnippet: "Use todo_read to see the assigned task or list neighbouring tasks; never read todo.toml directly.",
		parameters: Type.Object({
			relation: Type.Optional(
				Type.Union(
					[Type.Literal("self"), Type.Literal("parent"), Type.Literal("children"), Type.Literal("siblings")],
					{ description: "What to look at, relative to the assigned task. Defaults to self." },
				),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			init(ctx);
			const store = read();
			const task = activeTask(store);
			if (!task) {
				return {
					content: [{ type: "text", text: "No task is currently assigned." }],
					details: {},
					isError: true,
				};
			}

			const relation = (params.relation ?? "self") as "self" | "parent" | "children" | "siblings";
			if (relation === "self") {
				const lines = [`${task.id} [${levelOf(task) === "plan" ? "plan" : kindOf(task)}] ${task.status} — ${task.title}`];
				if (task.detail) lines.push("", task.detail);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { relation, taskId: task.id },
				};
			}

			const parentId = task.parent ?? parentOf(task, store.tasks);
			let rows: Task[];
			if (relation === "parent") {
				const parent = parentId ? findTask(store, parentId) : undefined;
				rows = parent ? [parent] : [];
			} else if (relation === "children") {
				rows = childrenOf(task.id, store.tasks);
			} else {
				// A root task has no parent, so its siblings are the other roots.
				rows = (parentId ? childrenOf(parentId, store.tasks) : store.tasks.filter((row) => !row.parent)).filter(
					(row) => row.id !== task.id,
				);
			}

			if (!rows.length) {
				return {
					content: [{ type: "text", text: `${task.id} has no ${relation}.` }],
					details: { relation, count: 0 },
				};
			}

			// A breakdown may legally produce dozens of children; one tool call must
			// not be able to spend the whole window on them.
			const shown = rows.slice(0, TODO_READ_MAX_ROWS);
			const lines = shown.map(
				(row) => `${row.id} [${levelOf(row) === "plan" ? "plan" : kindOf(row)}] ${row.status} — ${row.title}`,
			);
			if (rows.length > shown.length) lines.push(`… ${rows.length - shown.length} more not shown.`);
			lines.push("", "Titles and status only — open their code if you need to know what they did.");
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { relation, count: rows.length },
			};
		},
	});

	/**
	 * The only way a planning round produces anything. Children are inserted
	 * beside their parent rather than appended, so the loop stays depth-first,
	 * and acts are ordered ahead of plans so every round lands work promptly.
	 */
	pi.registerTool({
		name: "todo_add",
		label: "Add Todo",
		description:
			"Add one of this planning round's next steps. Call once per item, the moment you decide it. Only use this while working a plan.",
		promptSnippet: "While planning, write each next step down with todo_add as you decide it.",
		parameters: Type.Object({
			title: Type.String({ description: "One line naming the work. Must stand on its own." }),
			detail: Type.String({
				description:
					"Everything the worker will need: files, commands, formats, constraints. This is the only context that item will ever have.",
			}),
			level: Type.Optional(
				Type.Union([Type.Literal("act"), Type.Literal("plan")], {
					description:
						"act = one session, one diff; you can name the files now. plan = you cannot yet, so it gets its own round later.",
				}),
			),
			kind: Type.Optional(
				Type.Union([Type.Literal("code"), Type.Literal("docs"), Type.Literal("research")], {
					description: "What an act produces. Ignored for a plan. Defaults to code.",
				}),
			),
			max_files: Type.Optional(
				Type.Number({
					description:
						"Only for an act whose work is inherently wide — a project scaffold, a rename across call sites. The file count above which this act is recorded as too coarse, replacing the project default. State why in the detail; the number is visible in the queue and the diff is still judged on its merits.",
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
			if (assignmentFor(parent) !== "plan") {
				return {
					content: [
						{
							type: "text",
							text: `${parent.id} is an act, not a plan. Do it rather than splitting it. If it is genuinely too large, call todo_block and say so.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const level = (params.level ?? "act") as TaskLevel;
			const kind = (params.kind ?? "code") as ActKind;
			const allowed = allowedChildLevels(levelOf(parent));
			if (level === "plan" && depthOf(parent, store.tasks) + 1 >= config.plan.max_depth) {
				return {
					content: [
						{
							type: "text",
							text: `${parent.id} is at the nesting cap (${config.plan.max_depth}); this round may only add acts. Cut the work into steps whose files you can name.`,
						},
					],
					details: {},
					isError: true,
				};
			}
			const roundSoFar = unfinishedChildren(parent.id, store.tasks).length;
			if (roundSoFar >= config.plan.max_children) {
				return {
					content: [
						{
							type: "text",
							text: `This round already has ${roundSoFar} item(s), which is the cap. Stop here and call todo_complete — you will be asked again once these are done.`,
						},
					],
					details: {},
					isError: true,
				};
			}
			if (!allowed.includes(level)) {
				return {
					content: [
						{ type: "text", text: `A ${levelOf(parent)} may only spawn ${allowed.join(" or ")}; got ${level}.` },
					],
					details: {},
					isError: true,
				};
			}

			// Asked before the row is inserted, and against every sibling
			// including the finished ones: the failure this catches is a round
			// re-queueing the step it already attempted, and by definition that
			// one is no longer open.
			const echo = nearDuplicate(params.title.trim(), childrenOf(parent.id, store.tasks));
			const wanted = params.id?.trim() || slugify(params.title);
			const id = uniqueId(store, wanted, parent.id);
			// Built through the factory so the row carries whatever metadata this
			// file's schema gives every other row — a child the loop added should
			// not be identifiable as such.
			const child = createTask(store, {
				id,
				title: params.title.trim(),
				detail: params.detail.trim() || undefined,
				parent: parent.id,
				level: level === "plan" ? "plan" : undefined,
				kind: level === "act" ? kind : undefined,
				// Inherited, never refreshed — see Task.research_budget.
				research_budget: level === "plan" ? researchBudgetOf(parent, config.plan.research_budget) : undefined,
				max_files: level === "act" ? params.max_files : undefined,
			});

			insertChildren(store, parent.id, [child]);
			write(store);

			const total = childrenOf(parent.id, store.tasks).length;
			// Both notes are advisory. Refusing here would be wrong — two steps
			// that read alike are sometimes genuinely two steps — but adding it
			// silently is worse: run 13 spent four and a half hours across three
			// iterations on one dead end, and nothing in the queue or in any
			// tool result ever said the work was already there.
			const notes: string[] = [];
			if (child.max_files) {
				notes.push(`Its file budget is ${child.max_files}, not the project's ${config.atomic.max_files}.`);
			}
			if (!id.endsWith(wanted)) {
				notes.push(`Note that ${parent.id}.${wanted} was taken, so this went in as ${id}.`);
			}
			if (echo) {
				notes.push(
					`Note that ${echo.task.id} (${echo.task.status}) is already titled "${echo.task.title}". ` +
						`If that is this same work, call todo_read children and drop one of them from your plan.`,
				);
			}
			return {
				content: [
					{
						type: "text",
						text: [`Added ${id} [${level === "plan" ? "plan" : kind}] under ${parent.id} (${total} so far).`, ...notes].join(
							" ",
						),
					},
				],
				details: { taskId: id, parent: parent.id, level, kind, duplicateOf: echo?.task.id },
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
	 * Shrink the thinking in one assistant turn that is already past.
	 *
	 * Reasoning reaches the model only when the provider replays it, which for
	 * the local worker means `requiresThinkingAsText` on its model entry. Before
	 * that it was thrown away every turn, and the worker paid for it: run 10 read
	 * AudioEngine.kt seven times and ran the same grep twice eight minutes apart,
	 * because the conclusions it had already reached were never in front of it.
	 * Worse than the re-reading, a worker with no trace of its own reasoning
	 * confabulates one — asked to repeat a number it had chosen a turn earlier it
	 * stated a different number, confidently, rather than admitting the gap.
	 *
	 * Replaying it in full brings back the other failure, where thinking
	 * accumulates until compaction fires and summarises thinking into yet more
	 * context. Keeping a fixed tail is the middle: past `keep_full_turns` the
	 * retained amount stops growing, so neither failure has room to develop.
	 */
	const trimThinking = (message: { content?: unknown }, keepBytes: number): number => {
		if (!Array.isArray(message.content)) return 0;
		let changed = 0;
		for (const block of message.content as { type?: string; thinking?: string }[]) {
			if (block?.type !== "thinking" || typeof block.thinking !== "string") continue;
			if (Buffer.byteLength(block.thinking, "utf8") <= keepBytes) continue;
			// Never empty: a provider replaying an empty reasoning block is a
			// wire-format question we have no reason to take on.
			block.thinking = keepBytes === 0 ? "[earlier reasoning dropped]" : truncateTail(block.thinking, keepBytes);
			changed += 1;
		}
		return changed;
	};

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
			if (message.role === "assistant") {
				elided += trimThinking(message, config.context.thinking_keep_bytes);
				continue;
			}
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
	 * Count a planning round's looking, and cut it off when the budget is gone.
	 *
	 * Run 4's planner spent a whole ten-minute round on thirteen exploratory
	 * calls and wrote nothing: "look first" is good advice with no stopping
	 * condition in it. The budget supplies one, and — this is the part that
	 * matters — it does not simply forbid the next call, it names the exit.
	 * A question that outlasts the budget is a research act; saying so converts
	 * unbounded in-session exploration into a queued item that is budgeted,
	 * verifiable and survives the session ending.
	 *
	 * Only plans are metered. An act is *supposed* to read the repository, and
	 * the todo tools are never counted in either case, since writing items down
	 * is the behaviour being bought.
	 */
	const spendLook = (store: Store, toolName: string): string | undefined => {
		const budget = config.plan.look_budget;
		if (budget <= 0) return;
		const task = activeTask(store);
		if (!task || assignmentFor(task) !== "plan") return;
		if (toolName.startsWith("todo_")) return;

		if (looks.taskId !== task.id) looks = { taskId: task.id, count: 0 };
		looks.count += 1;
		if (looks.count < budget) return;
		return `[Looking budget spent — ${looks.count} of ${budget} inspection calls this round. Stop looking. Anything you still do not know is a research act: add it with todo_add, in one line, and move on to writing this round's items.]`;
	};

	/**
	 * Pi's built-in cap is 50KB / 2000 lines — far too generous for a 27B.
	 * The full text goes to a temp file so nothing is actually lost.
	 */
	pi.on("tool_result", async (event, ctx) => {
		init(ctx);
		const store = read();
		if (!store.loop.running) return;

		const nudge = spendLook(store, event.toolName);
		const text = textOf(event.content);
		// Before the early return below: a tool whose output is small and whose
		// budget is unspent still has to reach the verifier.
		recordEvidence(event.toolName, text);
		const max = config.context.tool_output_max_bytes;
		const oversize = BULKY_TOOLS.has(event.toolName) && !!text && Buffer.byteLength(text, "utf8") > max;
		if (!nudge && !oversize) return;

		let body = text ?? "";
		if (oversize) {
			const share = HEAD_SHARE.get(event.toolName) ?? DEFAULT_HEAD_SHARE;
			spillDir = spillDir ?? mkdtempSync(join(tmpdir(), "todo-loop-"));
			const file = join(spillDir, `${event.toolName}-${Date.now()}.txt`);
			try {
				writeFileSync(file, text as string);
				body = `${truncateMiddle(text as string, max, share)}\n\n[output capped at ${max} bytes; full text at ${file}]`;
			} catch {
				if (!nudge) return;
			}
		}

		return { content: [{ type: "text", text: nudge ? `${body}\n\n${nudge}` : body }] };
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
		const planning = assignmentFor(task) === "plan";
		const summary = [
			"# Task state carried across compaction",
			`task:          ${task.id} [${planning ? "plan" : kindOf(task)}]: ${task.title}`,
			planning ? "job:           decide this round's next steps and add them with todo_add. Write no code." : "",
			task.detail ? `detail:        ${task.detail.trim().replace(/\n/g, "\n               ")}` : "",
			`attempt:       ${task.attempts + 1} of ${config.verify.max_attempts}`,
			planning
				? `added_this_round: ${
						unfinishedChildren(task.id, store.tasks)
							.map((child) => `${child.id} [${levelOf(child) === "plan" ? "plan" : kindOf(child)}]`)
							.join(", ") || "(none yet)"
					}`
				: `files_touched: ${files.length ? files.join(", ") : "(none yet)"}`,
			`last_failure:  ${store.loop.last_failure || "(none)"}`,
			"",
			planning
				? "Do not re-add items that are already listed above. Finish by calling todo_complete."
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
		// Under the shell driver every session ends with the task still marked
		// doing, because the driver — not the session — rules on it once the
		// process exits. Reading that as a silent stop halts the whole queue on
		// a task that was in fact finished and is about to be verified. The
		// driver needs no help here: it verifies the diff whether or not
		// todo_complete was ever called.
		if (shellDriven) return;
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
