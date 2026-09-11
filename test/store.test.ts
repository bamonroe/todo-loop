import assert from "node:assert/strict";
import { test } from "node:test";
import {
	childrenOf,
	counts,
	isLeaf,
	markBlocked,
	markDoing,
	markDone,
	nextLeaf,
	parentOf,
	parseStore,
	recordFailure,
	renderTree,
	rollup,
	serializeStore,
} from "../src/store.ts";

const sample = `
[loop]
running = true
current = "a.one"
iterations = 2

[[task]]
id = "a"
title = "Parent"
status = "todo"
attempts = 0

[[task]]
id = "a.one"
title = "First child"
status = "todo"
attempts = 1

[[task]]
id = "a.two"
title = "Second child"
status = "todo"
attempts = 0

[[task]]
id = "b"
title = "Standalone"
status = "todo"
attempts = 0
`;

test("derives hierarchy from dotted ids", () => {
	const store = parseStore(sample);
	const child = store.tasks[1];
	assert.equal(parentOf(child, store.tasks), "a");
	assert.equal(childrenOf("a", store.tasks).length, 2);
	assert.equal(isLeaf(store.tasks[0], store.tasks), false);
	assert.equal(isLeaf(child, store.tasks), true);
});

test("explicit parent overrides the dotted id", () => {
	const store = parseStore(`
[[task]]
id = "x"
title = "X"
[[task]]
id = "y"
parent = "x"
title = "Y"
`);
	assert.equal(parentOf(store.tasks[1], store.tasks), "x");
	assert.equal(isLeaf(store.tasks[0], store.tasks), false);
});

test("never hands out an interior node", () => {
	const store = parseStore(sample);
	const task = nextLeaf(store);
	assert.equal(task?.id, "a.one");
	assert.ok(isLeaf(task!, store.tasks));
});

test("skips done and blocked tasks", () => {
	const store = parseStore(sample);
	markDone(store, store.tasks[1], "done");
	assert.equal(nextLeaf(store)?.id, "a.two");
	markBlocked(store, store.tasks[2], "stuck");
	assert.equal(nextLeaf(store)?.id, "b");
});

test("rolls a parent up once all children are done", () => {
	const store = parseStore(sample);
	markDone(store, store.tasks[1], "one");
	assert.equal(store.tasks[0].status, "todo");
	markDone(store, store.tasks[2], "two");
	assert.equal(store.tasks[0].status, "done");
});

test("a blocked child reopens a rolled-up parent", () => {
	const store = parseStore(sample);
	markDone(store, store.tasks[1], "one");
	markDone(store, store.tasks[2], "two");
	assert.equal(store.tasks[0].status, "done");
	store.tasks[2].status = "blocked";
	rollup(store);
	assert.equal(store.tasks[0].status, "todo");
});

test("blocking stops the loop", () => {
	const store = parseStore(sample);
	markBlocked(store, store.tasks[1], "missing spec");
	assert.equal(store.loop.running, false);
	assert.equal(store.loop.current, "");
	assert.equal(store.tasks[1].reason, "missing spec");
});

test("failures accumulate and are remembered across sessions", () => {
	const store = parseStore(sample);
	assert.equal(recordFailure(store, store.tasks[1], "no tests"), 2);
	const reloaded = parseStore(serializeStore(store));
	assert.equal(reloaded.tasks[1].attempts, 2);
	assert.equal(reloaded.loop.last_failure, "no tests");
});

test("serializes and reparses without drift", () => {
	const store = parseStore(sample);
	markDone(store, store.tasks[3], "shipped");
	const reloaded = parseStore(serializeStore(store));
	assert.deepEqual(reloaded, store);
});

test("counts and tree render", () => {
	const store = parseStore(sample);
	const stats = counts(store);
	assert.equal(stats.todo, 4);
	assert.equal(stats.leaves, 3);
	const tree = renderTree(store);
	assert.match(tree, /○ a: Parent/);
	assert.match(tree, /  ○ a\.one: First child \(1 attempts\)/);
});

test("tolerates a missing or malformed queue gracefully", () => {
	const store = parseStore("[[task]]\ntitle = \"no id\"\n");
	assert.equal(store.tasks.length, 0);
	assert.equal(nextLeaf(store), undefined);
});

test("claiming a fresh task clears the last failure", () => {
	const store = parseStore(sample);
	store.loop.last_failure = "from an earlier task";
	markDoing(store, store.tasks[2], "abc123");
	assert.equal(store.loop.last_failure, "");
	assert.equal(store.loop.base_commit, "abc123");
});

test("retrying the same task keeps the rejection reason", () => {
	const store = parseStore(sample);
	recordFailure(store, store.tasks[1], "the route is never registered");
	markDoing(store, store.tasks[1], "abc123");
	assert.equal(store.loop.last_failure, "the route is never registered");
});
