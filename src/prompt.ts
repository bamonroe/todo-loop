/**
 * What the worker is told. Deliberately short: on a 27B, every token spent
 * restating the harness is a token not spent on the task.
 */

import {
	assignmentFor,
	depthOf,
	findTask,
	kindOf,
	levelOf,
	parentOf,
	recentlyCompleted,
	type Store,
	type Task,
} from "./store.ts";

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
	/** Files an act may touch before it counts as too coarse. */
	maxFiles?: number;
	/** Most items one planning round may add. */
	maxChildren?: number;
	/** Rounds this branch may still close with research alone. */
	researchBudget?: number;
	lookBudget?: number;
	/** Nesting backstop; at the cap a round may add acts only. */
	maxDepth?: number;
	/** Where research acts write what they find, so the next session can read it. */
	memoryFile?: string;
	/**
	 * The same build and test commands the verifier will run. Handing them to the
	 * worker is what turns a blind session into one with a compiler.
	 */
	buildCommand?: string;
	workerCheck?: string;
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

/**
 * The bar an act has to clear.
 *
 * Written as tests the model can actually apply rather than an adjective. "Keep
 * it small" is unfalsifiable; "name the files it touches" either succeeds or it
 * does not, and something that fails it is a plan rather than a failure.
 */
function atomicityRules(maxFiles: number): string {
	return [
		"## What makes an act atomic",
		"Every act you create must be finishable by one worker, in one session, with no memory of this one. That is a hard constraint — the worker will see only the text you write, not this conversation.",
		"",
		"Apply these tests to each act before you add it:",
		"- **Name the files, from what is on disk now.** If naming them means first deciding a design, it is not an act — make it a plan.",
		`- **Count them.** More than ${maxFiles} files means it is too big. Split it.`,
		'- **One sentence of intent.** If describing the change needs "and", it is two acts.',
		"- **Self-contained.** The worker cannot ask questions. Anything it needs — a file path, a command, a format, a constraint — goes in the detail or it does not exist.",
		"- **Verifiable from the diff alone.** A reviewer who sees only the diff and the text must be able to tell whether it was done.",
		"",
		"Err on the side of smaller. Two acts that are too small cost one extra session; one act that is too big fails verification repeatedly and stalls the queue.",
	].join("\n");
}

/**
 * What this branch has already delivered.
 *
 * The single most important block in the prompt, and the reason the whole
 * hierarchy was rewritten. A planner that can read the last few things that
 * landed is deciding the next step against a repository that contains them. The
 * old up-front breakdown had nothing to read — it designed an entire
 * application, interfaces and all, against an empty directory, and spent 82% of
 * its output tokens doing it. That was not a prompting failure. It was being
 * asked a question that had no available answer.
 */
function progressBlock(store: Store, task: Task): string {
	const done = recentlyCompleted(store, task.id, 5);
	if (!done.length) {
		return [
			"## What has been done so far",
			"Nothing yet. This is the first round on this item, so the repository is however you find it — look before you decide.",
		].join("\n");
	}
	return [
		"## What has been done so far",
		"The most recently finished steps under this item, oldest first. This is what is now on disk; decide the next steps against it, not against what you would have planned before it existed.",
		"",
		...done.map((row) => `- ${row.id}: ${row.title}${row.summary ? ` — ${row.summary.trim()}` : ""}`),
	].join("\n");
}

/**
 * The progress rule, stated with its current allowance filled in.
 *
 * The allowance is named out loud rather than left as a silent gate. A model
 * that is told it has one research round left can choose to spend it on the
 * right question; one that only discovers the rule by being rejected spends a
 * whole session finding out.
 */
function progressRule(budget: number, memoryFile?: string): string {
	const lines = [
		"## Every round must land at least one act",
		"A round that adds only plans is rejected. Planning that spawns more planning always feels productive and never risks a failing build, which is exactly why it is a gate and not a suggestion — something has to get written down each time round.",
	];
	if (budget > 0) {
		lines.push(
			"",
			`If there is genuinely nothing to build yet, a \`research\` act satisfies the rule: go and find something out, and write what you learn${memoryFile ? ` into \`${memoryFile}\`` : " down"} so the next session does not pay to rediscover it. **This branch may do that ${budget} more time(s).**`,
			"After that, a round has to include an act that writes to the repository itself.",
		);
	} else {
		lines.push(
			"",
			"**This branch has used its research allowance.** A round of research alone will now be rejected — this round needs an act that writes code or documentation into the repository. If you still feel under-informed, pick the smallest thing you can build with what you already know and build that; the next round gets to read the result.",
		);
	}
	return lines.join("\n");
}

/**
 * Two facts the worker cannot observe from inside its own session: that nobody
 * is coming, and that an impossible requirement has a sanctioned answer other
 * than stopping.
 *
 * The second half is the load-bearing one. One real planning round worked out,
 * correctly and at length, that the project it had been handed could not be
 * built as described — and then spent the rest of its window relitigating that
 * finding, because the prompt gave it nowhere to put it. Substituting the
 * nearest workable thing and recording the swap is the outcome we want; the
 * guard rails exist because this model is much better at deciding something is
 * impossible than at establishing it.
 */
function unattendedRule(options: PromptOptions): string {
	const record = options.memoryFile ? `write it into \`${options.memoryFile}\`` : "say so plainly in your summary";
	const block = options.mode === "tool" ? "`todo_block`" : "`BLOCKED:`";
	return [
		"## Nobody is watching this run",
		"This loop runs unattended. There is no one to ask and no one to approve anything. A question you stop on is a question that stays unanswered until a human happens to look, which may be hours from now or after the queue has emptied itself.",
		"",
		`So decide, and keep going. Where something turns out to be impossible as written, take the nearest thing that does work and broadly serves the same goal, then ${record}: what was asked, why it cannot be done, and what you did instead. A recorded substitution is a good outcome. Stopping is not, and neither is quietly building something narrower and leaving the next session to discover it.`,
		"",
		"**Impossible is a high bar and a rare finding.** A build that will not pass, an API you have not used before, an error you do not yet understand and a design you cannot see the end of are all ordinary work — they are not grounds for substituting something easier, and this is not a licence to take the easy road on anything merely hard. If you have not actually established that it cannot be done, it can.",
		`${block} is for when there is no workable substitute at all — not for when the only one available is unsatisfying.`,
	].join("\n");
}

/**
 * The prompt for a plan: decide the next few steps, write them down, stop.
 *
 * The instruction not to write code is backed by a mechanical check — a
 * non-empty diff rejects the round — so this is a description of the gate
 * rather than a plea.
 */
export function renderPlanPrompt(store: Store, task: Task, options: PromptOptions): string {
	const maxChildren = options.maxChildren ?? 5;
	const maxFiles = options.maxFiles ?? 5;
	const budget = options.researchBudget ?? 2;
	const lookBudget = options.lookBudget ?? 6;
	const depth = depthOf(task, store.tasks);
	const atDepthCap = depth + 1 >= (options.maxDepth ?? 8);
	const hasDone = recentlyCompleted(store, task.id, 1).length > 0;
	const parts: string[] = [];
	const chain = ancestryOf(store, task);

	if (chain.length) parts.push(`Working within: ${chain.join(" › ")}`);
	parts.push(`# Plan ${task.id}\n\n${task.title}`);
	if (task.detail) parts.push(task.detail.trim());

	parts.push(progressBlock(store, task));

	parts.push(
		[
			"## Your job",
			`You are **not** implementing this and you are **not** designing the whole of it. One question only: **what are the next ${maxChildren} things that need doing to move this forward?**`,
			"",
			"Fewer than that is fine — and better than padding. You will be asked again after these are done, with the results in front of you, so anything you cannot decide well right now is not lost. It is simply not this round's question.",
			"",
			`1. **Look, briefly.** Read what is on disk — the files, the tooling, what the last steps left behind${options.memoryFile ? `, and \`${options.memoryFile}\` for what earlier rounds already found out` : ""}. A round decided without looking invents work that does not need doing and misses work that does.`,
			`   You have about ${lookBudget} commands for this, and the harness will say so when they are gone. **Anything you cannot settle in them is not a question to keep digging at — it is a research act.** Write it down in one line and move on. Finding out is work; it belongs in the queue like any other work, where it gets its own session and is read by every round after it. A round that spends itself looking and writes nothing has produced nothing.`,
			"2. **Then write them down, one at a time.** Add each item the moment you decide it. Do not work them all out first: planning the whole batch before writing anything means holding every item in your head at once and re-deciding earlier ones as later ones change, and if this session ends early everything you worked out is lost while a written item is already safe.",
			"",
			"**On the record beats exactly right.** A one-line item that exists is worth more than the same item worked out perfectly and never written, and far more than the third pass over one you already settled. Nothing decided here is final: the next round reads these items with their results beside them and can correct any of it.",
			"",
			"So if you catch yourself weighing an item — arguing both sides, choosing between two designs, returning to one you already decided — stop there and make it a `plan`. That feeling is the signal, and `plan` is its answer every time. Deliberation is the most expensive thing this session can spend and the first thing lost if it ends early.",
			"",
			"Write no code. Change no files. The round is rejected automatically if the working tree changes — a plan produces queue entries, nothing else.",
		].join("\n"),
	);

	parts.push(
		[
			"## What you may add",
			"- `act` — one session, one diff. Pick its kind:",
			"  - `code` — writes or changes code.",
			"  - `docs` — writes or changes documentation.",
			options.memoryFile
				? `  - \`research\` — finds something out and appends what it learned to \`${options.memoryFile}\`, where the next session can read it.`
				: "  - `research` — finds something out and writes down what it learned.",
			atDepthCap
				? "\nYou are at the nesting cap, so this round may add acts only. Anything that feels too big has to be cut into acts you can name the files for."
				: "- `plan` — anything you cannot yet name the files for. It gets its own session later, which decides it with the earlier work already written and readable.\n\n**`plan` is the default.** Add an `act` only where you can already name the files without settling anything first; everything else is a `plan`, and you do not need to justify that to yourself. Deferring is not an admission that you could not work it out — a design decided now, against a repository that does not contain the earlier steps' code yet, is a guess, and a guess written into an act's detail is the only context its worker will ever have. The same decision made two rounds from now is made by someone who can read that code.\n\nOne act is still required each round. That is a floor, not a target: it is usually the one thing you could already have started before this round began.",
			"",
			"Order matters: add them in the order they should be worked. Later items may depend on earlier ones, never the reverse.",
		].join("\n"),
	);

	parts.push(progressRule(budget, options.memoryFile));
	parts.push(atomicityRules(maxFiles));
	parts.push(unattendedRule(options));

	parts.push(
		options.mode === "tool"
			? [
					"## How to add them",
					"Call `todo_add` once per item — `title`, `detail`, `level` (`act` or `plan`), and `kind` for an act. The parent is set for you.",
					"Put what the worker will need in `detail` — it is the only context that item will ever have. But write it in one pass. If you cannot fill it in without working the design out first, that is a `plan`, not an act you deliberate into shape.",
					"",
					"## Finishing",
					"When this round's items are written, call `todo_complete` with a one-line summary of what you decided and why.",
					hasDone
						? "If this item is genuinely finished — everything under it is done and there is no next step — add nothing at all and say so in the summary. An empty round is how a branch closes."
						: "This is the first round, so it has to produce work: an empty round will be rejected.",
					"Only call `todo_block` if you cannot plan at all — missing information, a contradiction, a broken precondition. It halts the whole queue for a human, so it is not the way to say \"this is smaller than it looked\".",
				].join("\n")
			: [
					"## How to add them",
					"Run, once per item:",
					"",
					"```",
					`todo add <id> "<title>" --parent ${task.id} --level <act|plan> --kind <code|docs|research> --detail "<everything the worker needs>"`,
					"```",
					"",
					"Put what the worker will need in `--detail` — it is the only context that item will ever have. But write it in one pass. If you cannot fill it in without working the design out first, that is a `plan`, not an act you deliberate into shape.",
					"",
					"## Finishing",
					"When this round's items are written, stop. Your final message must be a one-line summary of what you decided and why.",
					hasDone
						? "If this item is genuinely finished — everything under it is done and there is no next step — add nothing at all and say so. An empty round is how a branch closes."
						: "This is the first round, so it has to produce work: an empty round will be rejected.",
					"Only say `BLOCKED:` if you cannot plan at all — missing information, a contradiction, a broken precondition. It halts the whole queue for a human.",
				].join("\n"),
	);

	const rejected = rejectionBlock(
		"Previous round was rejected",
		options,
		"Fix exactly what is listed. Items that were already accepted stay as they are.",
	);
	if (rejected) parts.push(rejected);

	return parts.join("\n\n");
}

/**
 * The other leaves under the same parent, titles and status only.
 *
 * Never their `detail`: the eight siblings of one real round carried two to
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
/**
 * Tell the worker to check its work — without telling it how, where the
 * project already has something better.
 *
 * `worker_check` names the project's own affordance (its tools). Otherwise the
 * verifier's commands are named, which is all a project with no tooling has.
 * The rule is the same either way and is the part that matters: a model cannot
 * compile in its head, and must not finish on a failing build.
 */
function verificationBlock(options: PromptOptions): string | undefined {
	const guidance = options.workerCheck?.trim();
	const commands = [options.buildCommand, options.testCommand].filter((command): command is string => !!command?.trim());
	if (!guidance && !commands.length) return undefined;

	const how = guidance
		? [guidance]
		: [
				"These are the exact commands the verifier will run on your diff. Run them yourself first and get them green.",
				"",
				"```",
				...commands,
				"```",
				"",
				// Only meaningful for a raw command. A tool that shapes its own
				// output has already done this, and saying it anyway invites the
				// worker to pipe a tool result through tail.
				"Add `-q` or pipe to `tail` if the output is long — you need the errors, not the task list.",
			];

	return [
		"## Check your work before you finish",
		...how,
		"",
		"You cannot compile in your head: a missing import or a typo'd name looks correct when you read it back and fails instantly here. Check, fix what it reports, check again.",
		"Do not finish on a failing build. If you cannot get it green, say so rather than handing over code that does not compile.",
	].join("\n");
}

export function renderActPrompt(store: Store, task: Task, options: PromptOptions): string {
	const kind = kindOf(task);
	const parts: string[] = [];
	const chain = ancestryOf(store, task);

	if (chain.length) parts.push(`Working within: ${chain.join(" › ")}`);
	parts.push(`# ${kind === "research" ? "Research" : kind === "docs" ? "Documentation" : "Task"} ${task.id}\n\n${task.title}`);
	if (task.detail) parts.push(task.detail.trim());

	// The memory file is only worth writing if it is also read. A research act
	// that files a finding nobody is told to look at has produced a diff and
	// nothing else — which is how every session ends up re-deriving the same
	// facts about the toolchain, one expensive exploration at a time.
	if (options.memoryFile) {
		parts.push(
			[
				"## What earlier sessions worked out",
				`\`${options.memoryFile}\` is where previous sessions wrote what they found out — commands that work, paths, constraints, things that turned out not to be true. Read it before you start.`,
				"It is the only memory this project has. If you learn something durable while doing this task — an incantation that works, a version that does not — append it there as well.",
			].join("\n"),
		);
	}

	// A research act still has to leave a diff behind — the evidence check
	// rejects an empty one. That is deliberate: "I went and read some things" is
	// not a deliverable, and the next session cannot read a session that ended.
	if (kind === "research" && options.memoryFile) {
		parts.push(
			[
				"## This is a research act",
				`You are finding something out, not building. The deliverable is what you write into \`${options.memoryFile}\` — append a short, dated section with what you learned and, where it matters, the exact commands or paths that worked.`,
				"",
				"Write it for a session that has never seen this repository and cannot ask you anything. Facts and commands, not narration. A finding nobody writes down is a finding the next worker pays to rediscover.",
				"Do not change anything else.",
			].join("\n"),
		);
	}

	parts.push(
		[
			"## Scope",
			"Do exactly this item. Do not start the next one, refactor beyond it, or fix unrelated problems you notice — note those instead and move on.",
			`This task is meant to be atomic: roughly ${options.maxFiles ?? 5} files at most, finishable in this one session. If it turns out to be much larger than that, say so rather than pushing through — a task that does not fit is a queue bug, and reporting it is more useful than half-finishing it.`,
		].join("\n"),
	);

	parts.push(unattendedRule(options));

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
	const planning = assignmentFor(task) === "plan";
	const lines = [
		planning ? "# Assigned planning round (do not lose track of this)" : "# Assigned task (do not lose track of this)",
		chain.length ? `Context: ${chain.join(" › ")}` : "",
		`${task.id} [${planning ? "plan" : kindOf(task)}]: ${task.title}`,
		task.detail ? task.detail.trim() : "",
		// The one thing a planner must not drift on: it is writing queue entries,
		// not code, and the diff check will reject it if it does.
		planning
			? "You are deciding the next few steps, not implementing them. Add them with todo_add. Write no code — a non-empty diff rejects the round."
			: "",
		lastFailure ? `\nMost recent verification failure:\n${lastFailure.trim()}` : "",
		"",
		"Finish by calling todo_complete. Stopping without it halts the loop.",
	];
	return lines.filter(Boolean).join("\n");
}

/**
 * The prompt for whatever this item actually needs — a planning round or the
 * work itself. Callers pick the item; they should not have to pick the shape.
 */
export function renderAssignmentPrompt(store: Store, task: Task, options: PromptOptions): string {
	return assignmentFor(task) === "plan" ? renderPlanPrompt(store, task, options) : renderActPrompt(store, task, options);
}
