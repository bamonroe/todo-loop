import assert from "node:assert/strict";
import { test } from "node:test";
import { ancestryOf, renderAssignmentPrompt, renderPinnedTask, renderTaskPrompt } from "../src/prompt.ts";
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
	assert.match(renderTaskPrompt(store, task, { mode: "tool" }), /Working within: api: Build the API/);
});

test("tool mode requires the completion tool", () => {
	const prompt = renderTaskPrompt(store, task, { mode: "tool" });
	assert.match(prompt, /todo_complete/);
	assert.match(prompt, /todo_block/);
});

test("standalone mode asks for a summary instead", () => {
	const prompt = renderTaskPrompt(store, task, { mode: "standalone" });
	assert.doesNotMatch(prompt, /todo_complete/);
	assert.match(prompt, /BLOCKED:/);
});

test("carries the previous rejection with its attempt count", () => {
	const prompt = renderTaskPrompt(store, task, {
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
	assert.match(pinned, /api\.health \[task\]: Add a health endpoint/);
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

// ------------------------------------------------------- breakdown prompts

const epic = parseStore(`
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "epic"
status = "todo"
attempts = 0
detail = "Sessions, OAuth, password reset."
`);

test("a childless epic gets the breakdown prompt, not the task prompt", () => {
	const prompt = renderAssignmentPrompt(epic, epic.tasks[0], { mode: "tool", maxFiles: 5, minChildren: 2 });
	assert.match(prompt, /You are \*\*not\*\* implementing it/);
	assert.match(prompt, /todo_add/);
	assert.match(prompt, /at least 2 child items/);
	// The instruction has a mechanical check behind it, and says so.
	assert.match(prompt, /rejected automatically if the working tree changes/);
});

test("the breakdown prompt states the atomicity bar in checkable terms", () => {
	const prompt = renderAssignmentPrompt(epic, epic.tasks[0], { mode: "tool", maxFiles: 3, minChildren: 2 });
	assert.match(prompt, /Name the files/);
	assert.match(prompt, /More than 3 files/);
	assert.match(prompt, /no memory of this one/);
});

test("an epic may offer scope children; a scope may not", () => {
	const asEpic = renderAssignmentPrompt(epic, epic.tasks[0], { mode: "tool" });
	assert.match(asEpic, /`scope` — anything else/);
	// Scope is the default, not the fallback: the model produced zero scopes
	// across two real runs while the wording framed deferring as a failure to
	// work it out.
	assert.match(asEpic, /Prefer `scope` whenever naming the files would mean deciding a design first/);

	const scope = parseStore(`
[[task]]
id = "sessions"
title = "Rework session storage"
level = "scope"
status = "todo"
attempts = 0
`);
	const asScope = renderAssignmentPrompt(scope, scope.tasks[0], { mode: "tool" });
	assert.match(asScope, /A scope may only spawn tasks/);
});

test("the standalone breakdown prompt gives the CLI form instead of the tool", () => {
	const prompt = renderAssignmentPrompt(epic, epic.tasks[0], { mode: "standalone" });
	assert.match(prompt, /todo add <id>/);
	assert.match(prompt, /--parent auth/);
	assert.doesNotMatch(prompt, /todo_add/);
});

test("the pinned breakdown reminds the worker it is not writing code", () => {
	const pinned = renderPinnedTask(epic, epic.tasks[0], "");
	assert.match(pinned, /auth \[epic\]/);
	assert.match(pinned, /breaking this down, not implementing it/);
	assert.match(pinned, /a non-empty diff rejects the breakdown/);
});

test("an implementation task is told what to do if it does not fit", () => {
	const prompt = renderAssignmentPrompt(store, task, { mode: "tool", maxFiles: 5 });
	assert.match(prompt, /roughly 5 files at most/);
	assert.match(prompt, /a queue bug/);
});

test("a scope is told one task is a real answer; an epic is not", () => {
	const scope = parseStore(`
[[task]]
id = "sessions"
title = "Rework session storage"
level = "scope"
status = "todo"
attempts = 0
`);
	const asScope = renderAssignmentPrompt(scope, scope.tasks[0], { mode: "tool", minChildren: 2 });
	assert.match(asScope, /add exactly that one task — that is a real answer/);

	const asEpic = renderAssignmentPrompt(epic, epic.tasks[0], { mode: "tool", minChildren: 2 });
	assert.match(asEpic, /at least 2 child items/);
});

test("blocking is reserved for genuinely impossible work", () => {
	const prompt = renderAssignmentPrompt(epic, epic.tasks[0], { mode: "tool" });
	// The earlier wording sent a merely-small scope to todo_block, which halts
	// the whole queue and strands everything behind it.
	assert.match(prompt, /halts the whole queue/);
	assert.doesNotMatch(prompt, /single atomic task, or cannot be broken down/);
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

test("children are written as they are decided, not planned in one block", () => {
	// The run-2 breakdown spent 20,115 of its 21,878 output tokens on thinking,
	// 82% of it in two blocks at the end, and had written two children when it
	// was cut off. Everything worked out in those blocks died with the session.
	const prompt = renderAssignmentPrompt(epic, epic.tasks[0], { mode: "tool" });
	assert.match(prompt, /Add each child the moment you decide it\. Do not plan them all first\./);
	assert.match(prompt, /Keep the deliberation per child short/);
});
