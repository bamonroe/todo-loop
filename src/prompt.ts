/**
 * What the worker is told. Deliberately short: on a 27B, every token spent
 * restating the harness is a token not spent on the task.
 */

import { allowedChildLevels, assignmentFor, findTask, levelOf, parentOf, type Store, type Task } from "./store.ts";

/** Parent titles, root first. A leaf without its ancestors reads as a non sequitur. */
export function ancestryOf(store: Store, task: Task): string[] {
	const chain: string[] = [];
	const seen = new Set<string>([task.id]);
	let parentId = parentOf(task, store.tasks);
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = findTask(store, parentId);
		if (!parent) break;
		chain.unshift(`${parent.id}: ${parent.title}`);
		parentId = parentOf(parent, store.tasks);
	}
	return chain;
}

export interface PromptOptions {
	/** "tool" expects the worker to call todo_complete; "standalone" is the one-shot shell driver. */
	mode: "tool" | "standalone";
	lastFailure?: string;
	/** Every rejection so far, oldest first. Preferred over lastFailure when present. */
	rejections?: string[];
	attempts?: number;
	maxAttempts?: number;
	/** Files a leaf task may touch before it counts as too coarse. */
	maxFiles?: number;
	/** Smallest accepted breakdown. */
	minChildren?: number;
	/**
	 * The same build and test commands the verifier will run. Handing them to the
	 * worker is what turns a blind session into one with a compiler.
	 */
	buildCommand?: string;
	testCommand?: string;
}

/**
 * The rejection block.
 *
 * Shows every verdict so far rather than the last one. A worker on attempt three
 * that is told only why attempt two failed has no way of knowing attempt one was
 * rejected for the opposite reason, and oscillating between two wrong answers is
 * the characteristic failure of a retry loop with no memory.
 */
function rejectionBlock(heading: string, options: PromptOptions, closing: string): string | undefined {
	const history = options.rejections?.length ? options.rejections : options.lastFailure ? [options.lastFailure] : [];
	if (!history.length) return undefined;
	const attempt = options.attempts ?? history.length;
	const cap = options.maxAttempts ?? 3;
	const lines = [`## ${heading} (attempt ${attempt} of ${cap})`];
	if (history.length === 1) {
		lines.push(history[0].trim());
	} else {
		lines.push("Every attempt so far, oldest first. Do not retry an approach already rejected here.");
		history.forEach((reason, index) => lines.push(`${index + 1}. ${reason.trim()}`));
	}
	lines.push(closing);
	return lines.join("\n");
}

/** "a scope" but "an epic" — the level is interpolated into prose all over this file. */
function article(level: string): string {
	return `${/^[aeiou]/i.test(level) ? "an" : "a"} ${level}`;
}

/**
 * The bar a child task has to clear.
 *
 * Written as tests the model can actually apply rather than an adjective. "Keep
 * it small" is unfalsifiable; "name the files it touches" either succeeds or it
 * does not, and a scope that fails it is still a scope.
 */
function atomicityRules(maxFiles: number): string {
	return [
		"## What makes a task atomic",
		`Every task you create must be finishable by one worker, in one session, with no memory of this one. That is a hard constraint — the worker will see only the task text you write, not this conversation.`,
		"",
		"Apply these tests to each task before you add it:",
		`- **Name the files.** If you cannot say which files it touches, it is not a task — make it a scope instead.`,
		`- **Count them.** More than ${maxFiles} files means it is too big. Split it.`,
		"- **One sentence of intent.** If describing the change needs \"and\", it is two tasks.",
		"- **Self-contained.** The worker cannot ask questions. Anything it needs — a file path, a function name, a format, a constraint — goes in the task detail or it does not exist.",
		"- **Verifiable from the diff alone.** A reviewer who sees only the diff and the task text must be able to tell whether it was done.",
		"",
		"Err on the side of smaller. Two tasks that are too small cost one extra session; one task that is too big fails verification repeatedly and stalls the queue.",
	].join("\n");
}

/**
 * Prompt for a scope or an epic: enumerate children, touch nothing else.
 *
 * The instruction not to write code is backed by a mechanical check — a
 * non-empty diff rejects the breakdown — so this is a description of the gate
 * rather than a plea.
 */
export function renderDecomposePrompt(store: Store, task: Task, options: PromptOptions): string {
	const level = levelOf(task);
	const allowed = allowedChildLevels(level);
	const minChildren = options.minChildren ?? 2;
	const maxFiles = options.maxFiles ?? 5;
	const parts: string[] = [];
	const chain = ancestryOf(store, task);

	if (chain.length) parts.push(`Working within: ${chain.join(" › ")}`);
	parts.push(`# ${level === "epic" ? "Epic" : "Scope"} ${task.id}\n\n${task.title}`);
	if (task.detail) parts.push(task.detail.trim());

	parts.push(
		[
			"## Your job",
			`This is ${article(level)}, not a task. You are **not** implementing it. You are breaking it down.`,
			"",
			"1. **Investigate first.** Read the code this touches — the files, the existing patterns, what is already there. A breakdown written without looking at the repository invents work that does not need doing and misses work that does.",
			level === "epic"
				? `2. **Then enumerate.** Add at least ${minChildren} child items covering everything this epic needs.`
				: `2. **Then enumerate.** Add a child task for each piece of work this scope turns out to need. If it turns out to be a single atomic task, add exactly that one task — that is a real answer, not a failure.`,
			"",
			`Write no code. Change no files. The breakdown is rejected automatically if the working tree changes — ${article(level)} produces queue entries, nothing else.`,
		].join("\n"),
	);

	parts.push(
		[
			"## What the children may be",
			allowed.includes("scope")
				? `- \`task\` — atomic, implementable exactly as written (see below).\n- \`scope\` — still needs investigation before it can be split into tasks. Use this where the work is real but the shape is not yet clear.`
				: `- \`task\` — atomic, implementable exactly as written (see below). A scope may only spawn tasks, so everything you add here must clear the bar below.`,
			"",
			"Order matters: add them in the order they should be worked. Later tasks may depend on earlier ones, never the reverse.",
		].join("\n"),
	);

	parts.push(atomicityRules(maxFiles));

	parts.push(
		options.mode === "tool"
			? [
					"## How to add them",
					"Call `todo_add` once per child — `title`, `detail`, and `level`. The parent is set for you.",
					"Put everything the worker will need in `detail`. It is the only context that task will ever have.",
					"",
					"## Finishing",
					"When every child is added, call `todo_complete` with a one-line summary of how you split it.",
					`Only call \`todo_block\` if this ${level} genuinely cannot be broken down — missing information, a contradiction, a broken precondition. It halts the whole queue for a human, so it is not the way to say "this is smaller than it looked".`,
				].join("\n")
			: [
					"## How to add them",
					"Run, once per child:",
					"",
					"```",
					`todo add <id> "<title>" --parent ${task.id} --level <task|scope> --detail "<everything the worker needs>"`,
					"```",
					"",
					"Put everything the worker will need in `--detail`. It is the only context that task will ever have.",
					"",
					"## Finishing",
					"When every child is added, stop. Your final message must be a one-line summary of how you split it.",
					`Only say \`BLOCKED:\` if this ${level} genuinely cannot be broken down — missing information, a contradiction, a broken precondition. It halts the whole queue for a human, so it is not the way to say "this is smaller than it looked".`,
				].join("\n"),
	);

	const rejected = rejectionBlock(
		"Previous breakdown was rejected",
		options,
		"Fix exactly what is listed. Children that were already accepted stay as they are.",
	);
	if (rejected) parts.push(rejected);

	return parts.join("\n\n");
}

/**
 * The other leaves under the same parent, titles and status only.
 *
 * Never their `detail`: the eight siblings of one real breakdown carried two to
 * three hundred words each, and pasting that into a small local window costs
 * more than the file read this is meant to replace.
 */
function siblingTitles(store: Store, task: Task): string[] {
	const parent = task.parent;
	const rows = store.tasks.filter((row) => row.id !== task.id && (row.parent ?? "") === (parent ?? ""));
	return rows.slice(0, 12).map((row) => `- ${row.id} [${row.status}] ${row.title}`);
}

/**
 * The commands the verifier is about to run, handed to the worker so it can run
 * them first.
 *
 * Before this the worker wrote code blind: `build_command` reached the verifier
 * and nothing else, so the first compile of a task happened after the worker's
 * session had already ended. A missing `import kotlin.math.min` — fifteen
 * seconds of compiler time — instead cost a two-hour session and a rejection,
 * because nothing in the loop could catch it while there was still a model
 * around to fix it.
 *
 * `-q` matters more than it looks. A gradle build prints fifty lines of
 * UP-TO-DATE task spam, and dumping that into a small window on every check
 * would cost more context than the retry it saves. Quiet, a pass is one line and
 * a failure is the compiler error alone.
 */
function verificationBlock(options: PromptOptions): string | undefined {
	const commands = [options.buildCommand, options.testCommand].filter((command): command is string => !!command?.trim());
	if (!commands.length) return undefined;
	return [
		"## Check your work before you finish",
		"These are the exact commands the verifier will run on your diff. Run them yourself first and get them green.",
		"",
		"```",
		...commands,
		"```",
		"",
		"You cannot compile in your head: a missing import or a typo'd name looks correct when you read it back and fails instantly here. Run them, fix what they report, run again.",
		"Add `-q` or pipe to `tail` if the output is long — you need the errors, not the task list.",
		"Do not finish on a failing build. If you cannot get it green, say so rather than handing over code that does not compile.",
	].join("\n");
}

export function renderTaskPrompt(store: Store, task: Task, options: PromptOptions): string {
	const parts: string[] = [];
	const chain = ancestryOf(store, task);

	if (chain.length) parts.push(`Working within: ${chain.join(" › ")}`);
	parts.push(`# Task ${task.id}\n\n${task.title}`);
	if (task.detail) parts.push(task.detail.trim());

	parts.push(
		[
			"## Scope",
			"Do exactly this task. Do not start the next one, refactor beyond it, or fix unrelated problems you notice — note those instead and move on.",
			`This task is meant to be atomic: roughly ${options.maxFiles ?? 5} files at most, finishable in this one session. If it turns out to be much larger than that, say so rather than pushing through — a task that does not fit is a queue bug, and reporting it is more useful than half-finishing it.`,
		].join("\n"),
	);

	const neighbours = siblingTitles(store, task);
	if (neighbours.length) {
		// Handed over unasked, titles only. A worker with no idea what the
		// neighbouring tasks are goes looking, and the only door it has is the
		// queue file: one real session spent its window on
		// `awk '/id = "eq.add-system/...' todo.toml`, pulling whole sibling
		// details into a window that could not afford them. Fifty tokens here
		// answers the question it was actually asking — is this mine or the next
		// task's — and removes the motive.
		//
		// Telling it not to read the file lives on todo_read's promptSnippet, not
		// here. The snippet is attached to the affordance and costs one line; this
		// block is rendered per task and would repeat the same sentence forever.
		parts.push(
			[
				"## The tasks around this one",
				"Titles only, for boundaries. Work that belongs to another task is not yours to do, and not yours to fix.",
				"",
				...neighbours,
			].join("\n"),
		);
	}

	const rejected = rejectionBlock(
		"Previous attempt was rejected",
		options,
		"Address exactly what is missing. Do not redesign work that was already accepted.",
	);
	if (rejected) parts.push(rejected);

	const checks = verificationBlock(options);
	if (checks) parts.push(checks);

	parts.push(
		options.mode === "tool"
			? [
					"## Finishing",
					"When the task is genuinely done, call `todo_complete` with a one-line summary. That call is the only way to finish — stopping without it halts the loop.",
					"If the task cannot be done as written, call `todo_block` with the reason instead of guessing.",
				].join("\n")
			: [
					"## Finishing",
					"When the task is genuinely done, stop. Your final message must be a one-line summary of what changed.",
					"If the task cannot be done as written, say `BLOCKED:` followed by the reason.",
				].join("\n"),
	);

	return parts.join("\n\n");
}

/**
 * Pinned into the system prompt, where no amount of context surgery can reach
 * it. The worker can lose its exploration; it must never lose the task.
 */
export function renderPinnedTask(store: Store, task: Task, lastFailure: string): string {
	const chain = ancestryOf(store, task);
	const decomposing = assignmentFor(task) === "decompose";
	const lines = [
		decomposing ? "# Assigned breakdown (do not lose track of this)" : "# Assigned task (do not lose track of this)",
		chain.length ? `Context: ${chain.join(" › ")}` : "",
		`${task.id} [${levelOf(task)}]: ${task.title}`,
		task.detail ? task.detail.trim() : "",
		// The one thing a decomposing worker must not drift on: it is writing
		// queue entries, not code, and the diff check will reject it if it does.
		decomposing
			? "You are breaking this down, not implementing it. Add child tasks with todo_add. Write no code — a non-empty diff rejects the breakdown."
			: "",
		lastFailure ? `\nMost recent verification failure:\n${lastFailure.trim()}` : "",
		"",
		"Finish by calling todo_complete. Stopping without it halts the loop.",
	];
	return lines.filter(Boolean).join("\n");
}

/**
 * The prompt for whatever this item actually needs — implementation or a
 * breakdown. Callers pick the task; they should not have to pick the shape.
 */
export function renderAssignmentPrompt(store: Store, task: Task, options: PromptOptions): string {
	return assignmentFor(task) === "decompose"
		? renderDecomposePrompt(store, task, options)
		: renderTaskPrompt(store, task, options);
}
