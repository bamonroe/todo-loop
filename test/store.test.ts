import assert from "node:assert/strict";
import { test } from "node:test";
import {
	discardChildren,
	childrenOf,
	counts,
	fileBudgetOf,
	isPromotable,
	isLeaf,
	markBlocked,
	markDoing,
	markDone,
	nextReady,
	parentOf,
	parseStore,
	promoteToPlan,
	recordFailure,
	renderTree,
	rollup,
	serializeStore,
	type Task,
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
	const task = nextReady(store);
	assert.equal(task?.id, "a.one");
	assert.ok(isLeaf(task!, store.tasks));
});

test("skips done and blocked tasks", () => {
	const store = parseStore(sample);
	markDone(store, store.tasks[1], "done");
	assert.equal(nextReady(store)?.id, "a.two");
	markBlocked(store, store.tasks[2], "stuck");
	assert.equal(nextReady(store)?.id, "b");
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
	assert.equal(nextReady(store), undefined);
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

/**
 * A breakdown cut off partway had written 2 of ~8 children. The tree reverted
 * cleanly but the queue kept them, and the loop started building against the
 * fragment — every task in it individually verifiable, six of them simply
 * absent.
 */
test("discardChildren removes a truncated breakdown's whole subtree", () => {
	const store = parseStore(`
[[task]]
id = "eq"
title = "An equalizer app"
level = "epic"
status = "doing"
attempts = 0

[[task]]
id = "eq.scaffold"
title = "Scaffold gradle"
parent = "eq"
status = "todo"
attempts = 0

[[task]]
id = "eq.engine"
title = "Engine interface"
parent = "eq"
level = "scope"
status = "todo"
attempts = 0

[[task]]
id = "eq.engine.iface"
title = "Write the interface"
parent = "eq.engine"
status = "todo"
attempts = 0

[[task]]
id = "other"
title = "Unrelated work"
status = "todo"
attempts = 0
`);

	const dropped = discardChildren(store, "eq");

	assert.deepEqual(dropped.sort(), ["eq.engine", "eq.engine.iface", "eq.scaffold"]);
	assert.deepEqual(
		store.tasks.map((task) => task.id),
		["eq", "other"],
		"the epic itself and unrelated work survive; a grandchild does not outlive its parent's rejection",
	);
});

test("discardChildren on a leaf changes nothing", () => {
	const store = parseStore(`
[[task]]
id = "solo"
title = "A leaf"
status = "todo"
attempts = 0
`);
	assert.deepEqual(discardChildren(store, "solo"), []);
	assert.equal(store.tasks.length, 1);
});

// ---------------------------------- what a killed attempt leaves on the row

const killed = `
[[task]]
id = "a"
title = "Write the sliders"
status = "todo"
attempts = 1
interrupted_thinking = "javap cannot read the Compose jar; decompiling by hand is a dead end"
`;

test("a killed attempt's reasoning survives a save and a reload", () => {
	const store = parseStore(killed);
	assert.match(store.tasks[0].interrupted_thinking ?? "", /decompiling by hand is a dead end/);
	const again = parseStore(serializeStore(store));
	assert.equal(again.tasks[0].interrupted_thinking, store.tasks[0].interrupted_thinking);
});

test("the carried-tree marker survives a save and a reload", () => {
	const store = parseStore(killed);
	store.loop.carried = "a";
	assert.equal(parseStore(serializeStore(store)).loop.carried, "a");
});

test("finishing the work drops the reasoning and the marker", () => {
	// Otherwise they follow the id into the archive and are written out on every
	// save from then on.
	const store = parseStore(killed);
	store.loop.carried = "a";
	markDone(store, store.tasks[0], "shipped");
	assert.equal(store.tasks[0].interrupted_thinking, undefined);
	assert.equal(store.loop.carried, "");
});

test("blocking keeps the reasoning, because that is what a human reads", () => {
	const store = parseStore(killed);
	markBlocked(store, store.tasks[0], "out of attempts");
	assert.match(store.tasks[0].interrupted_thinking ?? "", /dead end/);
});

test("promotion drops it, since nobody will implement that act now", () => {
	const store = parseStore(killed);
	store.loop.carried = "a";
	promoteToPlan(store, store.tasks[0], "too big");
	assert.equal(store.tasks[0].interrupted_thinking, undefined);
	assert.equal(store.loop.carried, "");
});

test("an act may carry its own file budget, and only an act", () => {
	// A scaffold is wide and still one thing: run 14's touched thirteen files
	// and 444 lines, built green, and was stamped too coarse anyway.
	assert.equal(fileBudgetOf({ id: "a", title: "a", status: "todo", attempts: 0 }, 5), 5);
	assert.equal(fileBudgetOf({ id: "a", title: "a", status: "todo", attempts: 0, max_files: 14 }, 5), 14);
	// A zero or negative budget would make every act overflow, including the
	// one-file ones, so it falls back rather than being honoured.
	assert.equal(fileBudgetOf({ id: "a", title: "a", status: "todo", attempts: 0, max_files: 0 }, 5), 5);

	const store = parseStore(`
[[task]]
id = "wide"
title = "Scaffold the project"
max_files = 13
`);
	assert.equal(store.tasks[0].max_files, 13, "it survives a parse");
	assert.match(serializeStore(store), /max_files = 13/, "and a write, so the number stays visible in the queue");
});

test("only a code act is broken into children when it overruns", () => {
	const act = (kind?: string): Task =>
		({ id: "a", title: "a", status: "todo", attempts: 0, kind }) as Task;
	assert.equal(isPromotable(act()), true, "a code act is the whole point of promotion");
	assert.equal(isPromotable(act("code")), true);
	// Breaking a one-file note into children produces children that each write
	// part of a file. Run 11 halted on exactly that cascade.
	assert.equal(isPromotable(act("docs")), false);
	assert.equal(isPromotable(act("research")), false);
	assert.equal(isPromotable({ id: "a", title: "a", status: "todo", attempts: 0, level: "plan" } as Task), false);
});
