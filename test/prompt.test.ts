import assert from "node:assert/strict";
import { test } from "node:test";
import { ancestryOf, renderAssignmentPrompt, renderPinnedTask, renderActPrompt } from "../src/prompt.ts";
import { parseStore } from "../src/store.ts";

const store = parseStore(`
[[task]]
id = "api"
title = "Build the API"
[[task]]
id = "api.health"
title = "Add a health endpoint"
detail = "Return 200 and a JSON body."
attempts = 1
`);

const task = store.tasks[1];

test("includes ancestors so a leaf is not a non sequitur", () => {
	assert.deepEqual(ancestryOf(store, task), ["api: Build the API"]);
	assert.match(renderActPrompt(store, task, { mode: "tool" }), /Working within: api: Build the API/);
});

test("tool mode requires the completion tool", () => {
	const prompt = renderActPrompt(store, task, { mode: "tool" });
	assert.match(prompt, /todo_complete/);
	assert.match(prompt, /todo_block/);
});

test("standalone mode asks for a summary instead", () => {
	const prompt = renderActPrompt(store, task, { mode: "standalone" });
	assert.doesNotMatch(prompt, /todo_complete/);
	assert.match(prompt, /BLOCKED:/);
});

test("carries the previous rejection with its attempt count", () => {
	const prompt = renderActPrompt(store, task, {
		mode: "tool",
		lastFailure: "The route is never registered.",
		attempts: 1,
		maxAttempts: 3,
	});
	assert.match(prompt, /attempt 1 of 3/);
	assert.match(prompt, /route is never registered/);
});

test("the pinned version carries task, detail and last failure", () => {
	const pinned = renderPinnedTask(store, task, "No tests were added.");
	assert.match(pinned, /api\.health \[code\]: Add a health endpoint/);
	assert.match(pinned, /Return 200/);
	assert.match(pinned, /No tests were added/);
});

test("cycles in explicit parents do not hang", () => {
	const cyclic = parseStore(`
[[task]]
id = "a"
parent = "b"
title = "A"
[[task]]
id = "b"
parent = "a"
title = "B"
`);
	assert.ok(ancestryOf(cyclic, cyclic.tasks[0]).length <= 2);
});

// ---------------------------------------------------------- plan prompts

const plan = parseStore(`
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "plan"
status = "todo"
attempts = 0
detail = "Sessions, OAuth, password reset."
`);

const PLAN_OPTS = { mode: "tool" as const, maxFiles: 5, maxChildren: 5, researchBudget: 2, maxDepth: 8 };

test("a plan gets the planning prompt, not the act prompt", () => {
	const prompt = renderAssignmentPrompt(plan, plan.tasks[0], PLAN_OPTS);
	assert.match(prompt, /You are \*\*not\*\* implementing this/);
	assert.match(prompt, /todo_add/);
	// The instruction has a mechanical check behind it, and says so.
	assert.match(prompt, /rejected automatically if the working tree changes/);
});

test("the planning prompt asks for the next few steps, not the whole project", () => {
	// The whole reason the hierarchy was rewritten: asked to scope an entire
	// project up front, the model spent 82% of its output tokens designing an
	// application against an empty directory.
	const prompt = renderAssignmentPrompt(plan, plan.tasks[0], { ...PLAN_OPTS, maxChildren: 5 });
	assert.match(prompt, /what are the next 5 things that need doing/i);
	assert.match(prompt, /not\*\* designing the whole of it/);
	assert.match(prompt, /You will be asked again after these are done/);
});

test("a re-entered plan is handed what already landed", () => {
	const store = parseStore(`
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "plan"
status = "todo"
attempts = 0

[[task]]
id = "auth.init"
title = "Initialise the repository"
parent = "auth"
status = "done"
attempts = 0
summary = "git init plus a .gitignore."
`);
	const prompt = renderAssignmentPrompt(store, store.tasks[0], PLAN_OPTS);
	assert.match(prompt, /What has been done so far/);
	assert.match(prompt, /auth\.init: Initialise the repository — git init plus a \.gitignore\./);
	assert.match(prompt, /not against what you would have planned before it existed/);
});

test("a first round is told it cannot close the branch; a later one is told it can", () => {
	const first = renderAssignmentPrompt(plan, plan.tasks[0], PLAN_OPTS);
	assert.match(first, /first round, so it has to produce work/);

	const store = parseStore(`
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "plan"
status = "todo"
attempts = 0

[[task]]
id = "auth.init"
title = "Initialise the repository"
parent = "auth"
status = "done"
attempts = 0
`);
	const later = renderAssignmentPrompt(store, store.tasks[0], PLAN_OPTS);
	assert.match(later, /add nothing/);
	assert.match(later, /empty round is how a branch closes/);
});

test("closing is gated on pointing at work, not on an empty queue", () => {
	const store = parseStore(`
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "plan"
status = "todo"
attempts = 0

[[task]]
id = "auth.init"
title = "Initialise the repository"
parent = "auth"
status = "done"
attempts = 0
`);
	const prompt = renderAssignmentPrompt(store, store.tasks[0], PLAN_OPTS);
	// The gate: an empty queue is not the criterion, the goal is.
	assert.match(prompt, /an empty queue is not evidence of a met goal/);
	// Both criterion classes, each with its anchor.
	assert.match(prompt, /checkable parts .* need their check named/);
	assert.match(prompt, /good-faith parts .* need the work named/);
	// Naming nothing reopens the branch instead of closing it.
	assert.match(prompt, /name nothing for is not done — it becomes this round's items/);
	// The accounting is the human handoff.
	assert.match(prompt, /what a human reads to decide what to check first/);
});

test("a root plan's first round derives acceptance criteria into the memory file", () => {
	const opts = { ...PLAN_OPTS, memoryFile: "NOTES.md" };
	const root = renderAssignmentPrompt(plan, plan.tasks[0], opts);
	assert.match(root, /"Acceptance" section into `NOTES\.md`/);
	assert.match(root, /`checkable` \(a test or command can decide it\)/);
	assert.match(root, /`good-faith` \(the user asked for effort, not a measurement\)/);

	// A child plan's first round does not re-derive them...
	const child = parseStore(`
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "plan"
status = "doing"

[[task]]
id = "auth.ui"
title = "Plan the UI"
parent = "auth"
level = "plan"
status = "todo"
attempts = 0
`);
	const childPrompt = renderAssignmentPrompt(child, child.tasks[1], opts);
	assert.doesNotMatch(childPrompt, /"Acceptance" section/);

	// ...and without a memory file there is nowhere to put them.
	assert.doesNotMatch(renderAssignmentPrompt(plan, plan.tasks[0], PLAN_OPTS), /"Acceptance" section/);
});

test("the progress rule names the research allowance it has left", () => {
	const some = renderAssignmentPrompt(plan, plan.tasks[0], { ...PLAN_OPTS, researchBudget: 2, memoryFile: "NOTES.md" });
	assert.match(some, /Every round must land at least one act/);
	assert.match(some, /may do that 2 more time\(s\)/);
	assert.match(some, /NOTES\.md/);

	// An escape valve that never closes is a bypass, so the prompt says when it
	// has shut rather than letting the model discover it by being rejected.
	const none = renderAssignmentPrompt(plan, plan.tasks[0], { ...PLAN_OPTS, researchBudget: 0 });
	assert.match(none, /has used its research allowance/);
	assert.match(none, /needs an act that writes code or documentation/);
	assert.doesNotMatch(none, /may do that \d+ more time/);
});

test("deferring is offered as the default, and withdrawn at the nesting cap", () => {
	const prompt = renderAssignmentPrompt(plan, plan.tasks[0], PLAN_OPTS);
	assert.match(prompt, /Add an `act` only where you can already name the files without settling anything first/);

	const capped = renderAssignmentPrompt(plan, plan.tasks[0], { ...PLAN_OPTS, maxDepth: 1 });
	assert.match(capped, /at the nesting cap, so this round may add acts only/);
	assert.doesNotMatch(capped, /`plan` is the default/);
});

test("items are written as they are decided, not planned in one block", () => {
	// The run-2 round spent 20,115 of its 21,878 output tokens on thinking, 82%
	// of it in two blocks at the end, and had written two children when it was
	// cut off. Everything worked out in those blocks died with the session.
	const prompt = renderAssignmentPrompt(plan, plan.tasks[0], PLAN_OPTS);
	assert.match(prompt, /Add each item the moment you decide it/);
	assert.match(prompt, /On the record beats exactly right/);
	// Run 7 re-derived the same five items in three thinking blocks, flipping its
	// serialization choice between them, and got one item written before the clock
	// took it. Weighing an item is the signal to defer it, not to think harder.
	assert.match(prompt, /stop there and make it a `plan`/);
});

test("planning defers by default, with one act as the floor", () => {
	const prompt = renderAssignmentPrompt(plan, plan.tasks[0], PLAN_OPTS);
	assert.match(prompt, /\*\*`plan` is the default\.\*\*/);
	assert.match(prompt, /One act is still required each round\. That is a floor, not a target/);
	// A thin detail is a plan, not an act to deliberate into shape.
	assert.match(prompt, /write it in one pass/);
});

test("the standalone planning prompt gives the CLI form instead of the tool", () => {
	const prompt = renderAssignmentPrompt(plan, plan.tasks[0], { ...PLAN_OPTS, mode: "standalone" });
	assert.match(prompt, /todo add <id>/);
	assert.match(prompt, /--parent auth/);
	assert.match(prompt, /--kind <code\|docs\|research>/);
	assert.doesNotMatch(prompt, /todo_add/);
});

test("the pinned plan reminds the worker it is not writing code", () => {
	const pinned = renderPinnedTask(plan, plan.tasks[0], "");
	assert.match(pinned, /auth \[plan\]/);
	assert.match(pinned, /deciding the next few steps, not implementing them/);
	assert.match(pinned, /a non-empty diff rejects the round/);
});

test("an act is told what to do if it does not fit", () => {
	const prompt = renderAssignmentPrompt(store, task, { mode: "tool", maxFiles: 5 });
	assert.match(prompt, /roughly 5 files at most/);
	assert.match(prompt, /a queue bug/);
});

test("blocking is reserved for genuinely impossible work", () => {
	const prompt = renderAssignmentPrompt(plan, plan.tasks[0], PLAN_OPTS);
	assert.match(prompt, /halts the whole queue/);
});

test("a research act is told where its finding has to land", () => {
	const store = parseStore(`
[[task]]
id = "look"
title = "Find the Android build entry point"
kind = "research"
status = "todo"
attempts = 0
`);
	const prompt = renderAssignmentPrompt(store, store.tasks[0], { mode: "tool", memoryFile: "NOTES.md" });
	assert.match(prompt, /This is a research act/);
	assert.match(prompt, /NOTES\.md/);
	assert.match(prompt, /A finding nobody writes down is a finding the next worker pays to rediscover/);
});

/**
 * A worker that could not compile wrote `min(...)` with no `import
 * kotlin.math.min`, and nothing in the loop noticed until the verifier built it
 * — two hours after the only model that could have fixed it had gone.
 */
const QUEUE_WITH_SIBLINGS = parseStore(`
[[task]]
id = "eq"
title = "An equalizer app"
level = "epic"
status = "done"
attempts = 0

[[task]]
id = "eq.bands"
title = "Add band adaptation"
parent = "eq"
status = "doing"
attempts = 0
detail = "Write BandProfile.adapt."

[[task]]
id = "eq.ui"
title = "Add the slider row"
parent = "eq"
status = "todo"
attempts = 0
detail = "A long sibling detail that must never reach the worker's window."
`);

test("the worker is given the commands the verifier will run", () => {
	const prompt = renderAssignmentPrompt(QUEUE_WITH_SIBLINGS, QUEUE_WITH_SIBLINGS.tasks[1], {
		mode: "standalone",
		buildCommand: "build.sh :app:assembleDebug",
		testCommand: "build.sh :app:testDebugUnitTest",
	});
	assert.match(prompt, /build\.sh :app:assembleDebug/);
	assert.match(prompt, /build\.sh :app:testDebugUnitTest/);
	assert.match(prompt, /cannot compile in your head/);
	assert.match(prompt, /Do not finish on a failing build/);
});

test("no configured commands means no check block rather than an empty one", () => {
	const prompt = renderAssignmentPrompt(QUEUE_WITH_SIBLINGS, QUEUE_WITH_SIBLINGS.tasks[1], { mode: "standalone" });
	assert.doesNotMatch(prompt, /Check your work before you finish/);
});

test("sibling titles are handed over, sibling details are not", () => {
	const prompt = renderAssignmentPrompt(QUEUE_WITH_SIBLINGS, QUEUE_WITH_SIBLINGS.tasks[1], { mode: "standalone" });
	assert.match(prompt, /eq\.ui \[todo\] Add the slider row/);
	assert.doesNotMatch(
		prompt,
		/never reach the worker's window/,
		"handing over a sibling's detail costs more than the file read this replaces",
	);
	assert.match(prompt, /Write BandProfile\.adapt/, "the worker's own detail still comes through in full");
});


test("an act is pointed at the memory file, not just told to write it", () => {
	// A finding filed where nobody is told to look has produced a diff and
	// nothing else, which is how every session re-derives the same toolchain
	// facts one expensive exploration at a time.
	const prompt = renderAssignmentPrompt(store, task, { mode: "tool", memoryFile: "NOTES.md" });
	assert.match(prompt, /What earlier sessions worked out/);
	assert.match(prompt, /`NOTES\.md` is where previous sessions wrote what they found out/);
	assert.match(prompt, /Read it before you start/);
});

test("no memory file configured means no block about one", () => {
	assert.doesNotMatch(renderAssignmentPrompt(store, task, { mode: "tool" }), /What earlier sessions worked out/);
});

test("worker_check replaces the raw commands rather than joining them", () => {
	// Where the project has tools, pasting the verifier's shell commands into
	// the worker's prompt gives it two ways to do one job — and the worse one
	// costs more context than the retry it saves.
	const prompt = renderActPrompt(store, task, {
		mode: "tool",
		buildCommand: "BAM_STORE_PUBLISH=0 /data/android/build.sh /data/equalizer :app:assembleDebug",
		testCommand: "BAM_STORE_PUBLISH=0 /data/android/build.sh /data/equalizer :app:testDebugUnitTest",
		workerCheck: "Use android_build and android_test.",
	});

	assert.match(prompt, /Use android_build and android_test\./);
	assert.doesNotMatch(prompt, /build\.sh/, "the shell commands are the verifier's business, not the worker's");
	assert.doesNotMatch(prompt, /pipe to `tail`/, "a tool already shapes its own output");
	// The rule survives either way; it is the part that matters.
	assert.match(prompt, /cannot compile in your head/);
	assert.match(prompt, /Do not finish on a failing build/);
});

test("with no worker_check the commands are still named", () => {
	// A project with no tooling of its own has nothing else to go on.
	const prompt = renderActPrompt(store, task, {
		mode: "tool",
		buildCommand: "make build",
		testCommand: "make test",
	});
	assert.match(prompt, /make build/);
	assert.match(prompt, /make test/);
});

// ------------------------------------------------- worker_tools

test("worker_tools reaches both prompts, in the project's own words", () => {
	// The counterpart to worker_check: the generic prompt cannot name a
	// project's tools, so it renders the project's text or nothing.
	const guidance = "Read with treesitter_outline. Never rewrite a whole file.";
	const acted = renderActPrompt(store, task, { mode: "tool", workerTools: guidance });
	const planned = renderAssignmentPrompt(plan, plan.tasks[0], { ...PLAN_OPTS, workerTools: guidance });

	for (const prompt of [acted, planned]) {
		assert.match(prompt, /## How to read and change code here/);
		assert.match(prompt, /Read with treesitter_outline\. Never rewrite a whole file\./);
	}
});

test("a planner is told how to look before it has spent its look budget", () => {
	// Ordering is the whole point on the plan side. A planner that learns about
	// an outline tool after it has already grepped has learnt it too late.
	const prompt = renderAssignmentPrompt(plan, plan.tasks[0], {
		...PLAN_OPTS,
		lookBudget: 6,
		workerTools: "Use treesitter_outline.",
	});
	const look = prompt.indexOf("commands for this");
	const tools = prompt.indexOf("## How to read and change code here");
	const add = prompt.indexOf("## What you may add");
	assert.ok(look >= 0 && tools >= 0 && add >= 0);
	assert.ok(tools > look, "the tooling block follows the look budget it applies to");
	assert.ok(tools < add, "and precedes the round's own instructions");
});

test("no worker_tools means no block about one", () => {
	// A project with no tooling of its own already has read/write/bash habits;
	// repeating them back would cost tokens for nothing.
	for (const options of [{ mode: "tool" as const }, { ...PLAN_OPTS }, { mode: "tool" as const, workerTools: "   " }]) {
		assert.doesNotMatch(renderActPrompt(store, task, options), /How to read and change code here/);
	}
});

// ------------------------------------------------- the unattended-run rule

test("both prompts say the run is unattended and offer a recorded substitution", () => {
	const opts = { ...PLAN_OPTS, memoryFile: "NOTES.md" };
	const planned = renderAssignmentPrompt(plan, plan.tasks[0], opts);
	const acted = renderActPrompt(store, task, opts);

	for (const prompt of [planned, acted]) {
		assert.match(prompt, /Nobody is watching this run/);
		assert.match(prompt, /no one to ask/);
		// The escape hatch: substitute, do not stop, and do not narrow in silence.
		assert.match(prompt, /nearest thing that does work/);
		assert.match(prompt, /write it into `NOTES\.md`/);
		assert.match(prompt, /quietly building something narrower/);
		// ...and its guard rail, so it is not a licence to take the easy road.
		assert.match(prompt, /Impossible is a high bar/);
		assert.match(prompt, /not grounds for substituting something easier/);
		// Blocking stays the last resort, named in the mode's own vocabulary.
		assert.match(prompt, /`todo_block` is for when there is no workable substitute/);
	}
});

test("the unattended rule speaks the standalone driver's vocabulary", () => {
	const prompt = renderAssignmentPrompt(plan, plan.tasks[0], { ...PLAN_OPTS, mode: "standalone" });
	assert.match(prompt, /`BLOCKED:` is for when there is no workable substitute/);
	assert.doesNotMatch(prompt, /`todo_block` is for when there is no workable/);
	// No memory file configured, so the substitution is recorded in the summary.
	assert.match(prompt, /say so plainly in your summary/);
	assert.doesNotMatch(prompt, /Where something turns out to be impossible as written[^]*?write it into/);
});

test("shared prose cannot drift between driver modes", () => {
	// The refactor that introduced DRIVER_VOCABULARY exists because the two
	// hand-maintained mode branches had already diverged: standalone was missing
	// the "smaller than it looked" warning. Shared sentences must now appear in
	// both modes or neither.
	for (const mode of ["tool", "standalone"] as const) {
		const prompt = renderAssignmentPrompt(plan, plan.tasks[0], { ...PLAN_OPTS, mode });
		assert.match(prompt, /not the way to say "this is smaller than it looked"/);
		assert.match(prompt, /But write it in one pass/);
		assert.match(prompt, /An empty round is how a branch closes|an empty round will be rejected/);
	}
});

// ------------------------------------------- what a killed attempt hands on

test("a retry is told its predecessor's edits are still on disk", () => {
	const prompt = renderActPrompt(store, task, { mode: "tool", carriedWork: true });
	assert.match(prompt, /## What the last attempt left you/);
	assert.match(prompt, /still in the working tree/);
	assert.match(prompt, /stopped by the clock, not rejected for being wrong/);
	assert.match(prompt, /git diff/, "and how to look at it");
});

test("the dying worker's last thoughts are quoted, and framed as a lead not a plan", () => {
	// Run 13's 25/26/27: the same dead end three times, four and a half hours
	// each, because a retry begins from the task text and nothing else.
	const prompt = renderActPrompt(store, task, {
		mode: "tool",
		interruptedThinking: "javap cannot read the Compose jar, so decompiling by hand is a dead end.",
	});
	assert.match(prompt, /javap cannot read the Compose jar/);
	assert.match(prompt, /cut off mid-thought/);
	assert.match(prompt, /not as a plan to resume/, "it ran out of time; it was not winning");
	assert.match(prompt, /what has already been tried/);
});

test("both halves render together without repeating themselves", () => {
	const prompt = renderActPrompt(store, task, { mode: "tool", carriedWork: true, interruptedThinking: "half way through BandSliders" });
	assert.equal(prompt.match(/## What the last attempt left you/g)?.length, 1);
	assert.match(prompt, /still in the working tree/);
	assert.match(prompt, /half way through BandSliders/);
});

test("an ordinary attempt inherits nothing and is told nothing", () => {
	for (const options of [
		{ mode: "tool" as const },
		{ mode: "tool" as const, carriedWork: false, interruptedThinking: "   " },
	]) {
		assert.doesNotMatch(renderActPrompt(store, task, options), /What the last attempt left you/);
	}
});

test("the inheritance comes before the tooling and the scope rules", () => {
	// What is already on disk changes what the session should do first, so it
	// cannot arrive after the instructions about how to start.
	const prompt = renderActPrompt(store, task, {
		mode: "tool",
		carriedWork: true,
		workerTools: "Use treesitter_outline.",
	});
	const left = prompt.indexOf("## What the last attempt left you");
	const tools = prompt.indexOf("## How to read and change code here");
	const scope = prompt.indexOf("## Scope");
	assert.ok(left >= 0 && tools >= 0 && scope >= 0);
	assert.ok(left < tools && tools < scope);
});
