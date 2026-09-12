/**
 * Levels, the ordering they imply, and the mechanical gate on a breakdown.
 *
 * The through-line: a breakdown is judged without a model, so every rule here
 * is a fact about the store or the diff rather than a matter of opinion.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { checkDecomposition } from "../src/decompose.ts";
import {
	allowedChildLevels,
	assignmentFor,
	descendantsOf,
	effectiveLevel,
	findTask,
	insertChildren,
	levelOf,
	markOverflow,
	needsBreakdown,
	nextLeaf,
	parseStore,
	promoteToScope,
	serializeStore,
	type Task,
} from "../src/store.ts";

const config: Config = DEFAULT_CONFIG;

const epicQueue = `
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "epic"
status = "todo"
attempts = 0

[[task]]
id = "unrelated"
title = "Fix the footer spacing"
status = "todo"
attempts = 0
`;

function child(id: string, parent: string, title: string, level?: "task" | "scope"): Task {
	const task: Task = { id, title, parent, status: "todo", attempts: 0 };
	if (level && level !== "task") task.level = level;
	return task;
}

test("an absent level means task", () => {
	const store = parseStore(`
[[task]]
id = "a"
title = "Something atomic"
status = "todo"
attempts = 0
`);
	assert.equal(levelOf(store.tasks[0]), "task");
	assert.equal(assignmentFor(store.tasks[0]), "implement");
});

test("level survives the toml round trip, and task is not written out", () => {
	const store = parseStore(epicQueue);
	const text = serializeStore(store);
	assert.match(text, /level = "epic"/);
	// "task" is the default, so writing it would be noise in every row.
	assert.doesNotMatch(text, /level = "task"/);
	assert.equal(levelOf(parseStore(text).tasks[0]), "epic");
});

test("a childless epic is a breakdown, not an implementation", () => {
	const store = parseStore(epicQueue);
	const next = nextLeaf(store);
	assert.equal(next?.id, "auth");
	// The bug this fixes: before levels, this was indistinguishable from an
	// atomic task and got handed to the worker as one.
	assert.equal(assignmentFor(next!), "decompose");
	assert.equal(needsBreakdown(next!, store.tasks), true);
});

test("an epic with children is skipped entirely", () => {
	const store = parseStore(epicQueue);
	insertChildren(store, "auth", [child("auth.rotate", "auth", "Rotate the signing secrets")]);
	assert.equal(nextLeaf(store)?.id, "auth.rotate");
});

test("an epic spawns scopes or tasks; a scope spawns only tasks", () => {
	assert.deepEqual(allowedChildLevels("epic"), ["scope", "task"]);
	assert.deepEqual(allowedChildLevels("scope"), ["task"]);
	// "A task spawns code" — it owns nothing.
	assert.deepEqual(allowedChildLevels("task"), []);
});

test("children land beside their parent, not at the end of the queue", () => {
	const store = parseStore(epicQueue);
	insertChildren(store, "auth", [
		child("auth.rotate", "auth", "Rotate the signing secrets"),
		child("auth.mfa", "auth", "Add a TOTP second factor"),
	]);
	// Appending would push fresh work behind "unrelated" and turn the loop
	// breadth-first across every epic in the queue.
	assert.deepEqual(
		store.tasks.map((t) => t.id),
		["auth", "auth.rotate", "auth.mfa", "unrelated"],
	);
	assert.equal(nextLeaf(store)?.id, "auth.rotate");
});

test("a second round of breakdown stays inside the parent's block", () => {
	const store = parseStore(epicQueue);
	insertChildren(store, "auth", [child("auth.sessions", "auth", "Rework session storage", "scope")]);
	insertChildren(store, "auth.sessions", [child("auth.sessions.ttl", "auth.sessions", "Make the session TTL configurable")]);
	insertChildren(store, "auth", [child("auth.mfa", "auth", "Add a TOTP second factor")]);
	assert.deepEqual(
		store.tasks.map((t) => t.id),
		["auth", "auth.sessions", "auth.sessions.ttl", "auth.mfa", "unrelated"],
	);
	assert.deepEqual(
		descendantsOf("auth", store.tasks).map((t) => t.id),
		["auth.sessions", "auth.sessions.ttl", "auth.mfa"],
	);
});

// ------------------------------------------------------------ the breakdown gate

function brokenDown(): ReturnType<typeof parseStore> {
	const store = parseStore(epicQueue);
	insertChildren(store, "auth", [
		child("auth.rotate", "auth", "Rotate the signing secrets"),
		child("auth.mfa", "auth", "Add a TOTP second factor"),
	]);
	return store;
}

test("a well-formed breakdown passes without a model call", () => {
	const store = brokenDown();
	const verdict = checkDecomposition(store, findTask(store, "auth")!, [], config);
	assert.equal(verdict.pass, true);
	assert.equal(verdict.mechanical, true);
	assert.match(verdict.reason, /auth\.rotate, auth\.mfa/);
});

test("a breakdown that wrote code is rejected", () => {
	const store = brokenDown();
	const verdict = checkDecomposition(store, findTask(store, "auth")!, ["src/auth.ts"], config);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /not code/);
	assert.match(verdict.reason, /src\/auth\.ts/);
});

test("a breakdown with no children is rejected", () => {
	const store = parseStore(epicQueue);
	const verdict = checkDecomposition(store, findTask(store, "auth")!, [], config);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /no child tasks/);
});

test("an epic broken into one child is not a breakdown", () => {
	const store = parseStore(epicQueue);
	insertChildren(store, "auth", [child("auth.only", "auth", "Rebuild authentication properly")]);
	const verdict = checkDecomposition(store, findTask(store, "auth")!, [], config);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /at least 2/);
});

test("a scope may legitimately turn out to be a single task", () => {
	const store = parseStore(`
[[task]]
id = "sessions"
title = "Rework session storage"
level = "scope"
status = "todo"
attempts = 0
`);
	insertChildren(store, "sessions", [child("sessions.ttl", "sessions", "Make the session TTL configurable")]);
	// Rejecting this would leave the scope with no exit at all: one child is
	// refused and todo_block halts the entire queue. Termination is guaranteed
	// by the level rules, not by this minimum.
	assert.equal(checkDecomposition(store, findTask(store, "sessions")!, [], config).pass, true);
});

test("the level rules cap the chain at epic, scope, task", () => {
	// Why a scope may return one child safely: nothing can recurse forever.
	assert.ok(!allowedChildLevels("epic").includes("epic"));
	assert.ok(!allowedChildLevels("scope").includes("scope"));
	assert.deepEqual(allowedChildLevels("task"), []);
});

test("a scope may not spawn another scope", () => {
	const store = parseStore(`
[[task]]
id = "sessions"
title = "Rework session storage"
level = "scope"
status = "todo"
attempts = 0
`);
	insertChildren(store, "sessions", [
		child("sessions.a", "sessions", "Make the session TTL configurable"),
		child("sessions.b", "sessions", "Investigate the cookie flags", "scope"),
	]);
	const verdict = checkDecomposition(store, findTask(store, "sessions")!, [], config);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /may only spawn task/);
});

test("a child too thin to stand on its own is rejected", () => {
	const store = parseStore(epicQueue);
	insertChildren(store, "auth", [
		child("auth.a", "auth", "Rotate the signing secrets"),
		child("auth.b", "auth", "fix it"),
	]);
	const verdict = checkDecomposition(store, findTask(store, "auth")!, [], config);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /too short to stand on its own/);
});

test("min_children is configurable, and applies to epics", () => {
	const store = parseStore(epicQueue);
	insertChildren(store, "auth", [child("auth.only", "auth", "Rebuild authentication properly")]);
	const lenient: Config = { ...config, decompose: { min_children: 1 } };
	assert.equal(checkDecomposition(store, findTask(store, "auth")!, [], lenient).pass, true);

	const strict: Config = { ...config, decompose: { min_children: 3 } };
	assert.match(checkDecomposition(store, findTask(store, "auth")!, [], strict).reason, /at least 3/);
});

// --------------------------------------------------------------- atomicity

test("promotion turns an oversized task into a scope and clears its attempts", () => {
	const store = parseStore(`
[loop]
current = "big"

[[task]]
id = "big"
title = "Rewrite the whole data layer"
status = "doing"
attempts = 2
`);
	const task = findTask(store, "big")!;
	markOverflow(task, "touched 14 files (budget 5)");
	assert.equal(task.overflowed, true);

	promoteToScope(store, task, `Promoted to scope: ${task.overflow_reason}`);
	assert.equal(levelOf(task), "scope");
	assert.equal(task.status, "todo");
	// The attempts were spent on a task that was never atomic, so they are not
	// the worker's debt to carry.
	assert.equal(task.attempts, 0);
	assert.equal(store.loop.current, "");
	assert.equal(assignmentFor(task), "decompose");
});

test("overflow survives the toml round trip", () => {
	const store = parseStore(epicQueue);
	markOverflow(store.tasks[1], "touched 9 files (budget 5)");
	const back = parseStore(serializeStore(store));
	assert.equal(back.tasks[1].overflowed, true);
	assert.match(back.tasks[1].overflow_reason ?? "", /9 files/);
});

test("the assignment does not flip once the first child lands", () => {
	const store = parseStore(epicQueue);
	const auth = findTask(store, "auth")!;
	assert.equal(assignmentFor(auth), "decompose");
	insertChildren(store, "auth", [child("auth.rotate", "auth", "Rotate the signing secrets")]);
	// A breakdown creates children. If this flipped, the second todo_add of every
	// breakdown would be refused and no scope could ever produce more than one.
	assert.equal(assignmentFor(auth), "decompose");
	// The display question is the other way round: it has been broken down now.
	assert.equal(needsBreakdown(auth, store.tasks), false);
});

test("a pre-levels queue is still a valid queue", () => {
	// The README's own example: a dotted parent with no level field at all.
	const store = parseStore(`
[[task]]
id = "api"
title = "Build the health API"
status = "todo"
attempts = 0

[[task]]
id = "api.route"
title = "Add GET /health returning 200"
status = "todo"
attempts = 0
`);
	const api = findTask(store, "api")!;
	// It has children, so it is a container — which is what a parent always was
	// here. Nothing about it needs editing to keep working.
	assert.equal(effectiveLevel(api, store.tasks), "scope");
	assert.equal(needsBreakdown(api, store.tasks), false);
	assert.equal(nextLeaf(store)?.id, "api.route");
});

test("an explicit level = task with children is still a contradiction", () => {
	const store = parseStore(`
[[task]]
id = "api"
title = "Build the health API"
level = "task"
status = "todo"
attempts = 0

[[task]]
id = "api.route"
title = "Add GET /health returning 200"
status = "todo"
attempts = 0
`);
	assert.equal(effectiveLevel(findTask(store, "api")!, store.tasks), "task");
});
