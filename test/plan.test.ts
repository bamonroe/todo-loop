import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { checkPlanRound, nearDuplicate, titleSimilarity } from "../src/plan.ts";
import {
	allowedChildLevels,
	assignmentFor,
	createTask,
	findTask,
	insertChildren,
	isReady,
	kindOf,
	levelOf,
	needsPlanning,
	nextReady,
	parseStore,
	promoteToPlan,
	recentlyCompleted,
	renderTree,
	researchBudgetOf,
	rollup,
	serializeStore,
	type Store,
	unfinishedChildren,
} from "../src/store.ts";

const config: Config = DEFAULT_CONFIG;

function withRound(rows: string): Store {
	return parseStore(`
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "plan"
status = "todo"
attempts = 0
${rows}`);
}

// ------------------------------------------------------------------ levels

test("a plan may spawn either kind; an act may spawn nothing", () => {
	assert.deepEqual(allowedChildLevels("plan"), ["act", "plan"]);
	assert.deepEqual(allowedChildLevels("act"), []);
});

test("an item without a level is work, not planning", () => {
	const store = parseStore('[[task]]\nid = "a"\ntitle = "Do the thing"\nstatus = "todo"\nattempts = 0\n');
	assert.equal(levelOf(store.tasks[0]), "act");
	assert.equal(kindOf(store.tasks[0]), "code");
	assert.equal(assignmentFor(store.tasks[0]), "act");
});

test("a queue written against the old ladder still parses", () => {
	// epic and scope were both containers that produced queue entries, which is
	// exactly what a plan is. Nobody should have to hand-edit a queue to upgrade.
	const store = parseStore(`
[[task]]
id = "e"
title = "An epic"
level = "epic"
status = "todo"
attempts = 0
[[task]]
id = "s"
title = "A scope"
level = "scope"
status = "todo"
attempts = 0
[[task]]
id = "t"
title = "A task"
level = "task"
status = "todo"
attempts = 0
`);
	assert.equal(levelOf(findTask(store, "e")!), "plan");
	assert.equal(levelOf(findTask(store, "s")!), "plan");
	assert.equal(levelOf(findTask(store, "t")!), "act");
});

// ------------------------------------------------------------ re-entrancy

const REENTRANT = withRound(`
[[task]]
id = "auth.init"
title = "Initialise the repository"
parent = "auth"
status = "done"
attempts = 0

[[task]]
id = "auth.skeleton"
title = "Write the module skeleton"
parent = "auth"
status = "todo"
attempts = 0
`);

test("a plan is not ready while its batch is still running", () => {
	assert.equal(isReady(findTask(REENTRANT, "auth")!, REENTRANT.tasks), false);
	assert.equal(nextReady(REENTRANT)?.id, "auth.skeleton");
});

test("a plan becomes ready again once its whole batch has landed", () => {
	const store = withRound(`
[[task]]
id = "auth.init"
title = "Initialise the repository"
parent = "auth"
status = "done"
attempts = 0
`);
	assert.equal(isReady(findTask(store, "auth")!, store.tasks), true);
	assert.equal(nextReady(store)?.id, "auth", "the plan itself comes back for another round");
});

test("rollup never closes a plan on its children's behalf", () => {
	// Closing it here would end the branch at round one and delete the revisit
	// step the whole design turns on.
	const store = withRound(`
[[task]]
id = "auth.init"
title = "Initialise the repository"
parent = "auth"
status = "done"
attempts = 0
`);
	rollup(store);
	assert.equal(findTask(store, "auth")!.status, "todo");
});

test("an ordinary parent is still rolled up", () => {
	const store = parseStore(`
[[task]]
id = "api"
title = "Build the API"
status = "todo"
attempts = 0
[[task]]
id = "api.route"
title = "Add the route"
parent = "api"
status = "done"
attempts = 0
`);
	rollup(store);
	assert.equal(findTask(store, "api")!.status, "done");
});

test("the round being judged is exactly the unfinished children", () => {
	assert.deepEqual(
		unfinishedChildren("auth", REENTRANT.tasks).map((row) => row.id),
		["auth.skeleton"],
	);
	assert.deepEqual(
		recentlyCompleted(REENTRANT, "auth").map((row) => row.id),
		["auth.init"],
	);
});

test("a plan with no round yet is flagged as unplanned", () => {
	const store = withRound("");
	assert.equal(needsPlanning(findTask(store, "auth")!, store.tasks), true);
	assert.equal(needsPlanning(findTask(REENTRANT, "auth")!, REENTRANT.tasks), false);
});

// --------------------------------------------------------------- ordering

test("acts are inserted ahead of their plan siblings", () => {
	// The progress rule is a property of the data until this runs: left in
	// emission order, a round of [plan, plan, act] dives into the first plan and
	// the act might not run for hours.
	const store = withRound("");
	const emitted = [
		createTask(store, { id: "auth.think", title: "Work out the token format", parent: "auth", level: "plan" }),
		createTask(store, { id: "auth.git", title: "Initialise the repository", parent: "auth", kind: "code" }),
	];
	insertChildren(store, "auth", emitted);
	assert.deepEqual(
		store.tasks.map((row) => row.id),
		["auth", "auth.git", "auth.think"],
	);
	assert.equal(nextReady(store)?.id, "auth.git");
});

// ------------------------------------------------------------ round checks

function round(rows: string, files: string[] = [], cfg: Config = config) {
	return checkPlanRound(withRound(rows), findTask(withRound(rows), "auth")!, files, cfg);
}

const ONE_ACT = `
[[task]]
id = "auth.git"
title = "Initialise the repository"
parent = "auth"
status = "todo"
attempts = 0
`;

test("a round that touched the working tree is rejected", () => {
	const verdict = round(ONE_ACT, ["src/auth.ts"]);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /queue entries, not code/);
});

test("a clean round with one act passes", () => {
	const verdict = round(ONE_ACT);
	assert.equal(verdict.pass, true);
	assert.equal(verdict.finished, undefined);
	assert.equal(verdict.spentResearch, false);
});

test("an empty first round is rejected — it would close the project having built nothing", () => {
	const verdict = round("");
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /first round has to produce work/);
});

test("an empty later round is how a branch closes", () => {
	const verdict = round(`
[[task]]
id = "auth.git"
title = "Initialise the repository"
parent = "auth"
status = "done"
attempts = 0
`);
	assert.equal(verdict.pass, true);
	assert.equal(verdict.finished, true);
});

test("a round may not exceed the per-round cap", () => {
	let rows = "";
	for (let i = 0; i < 6; i++) {
		rows += `\n[[task]]\nid = "auth.${i}"\ntitle = "Do the numbered thing ${i}"\nparent = "auth"\nstatus = "todo"\nattempts = 0\n`;
	}
	const verdict = round(rows);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /at most 5/);
	assert.match(verdict.reason, /not the whole project/);
});

test("a round of nothing but plans is rejected", () => {
	const verdict = round(`
[[task]]
id = "auth.a"
title = "Decide the session strategy"
parent = "auth"
level = "plan"
status = "todo"
attempts = 0

[[task]]
id = "auth.b"
title = "Decide the token format"
parent = "auth"
level = "plan"
status = "todo"
attempts = 0
`);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /must land at least one act/);
});

test("a plan alongside a real act is fine", () => {
	const verdict = round(`
[[task]]
id = "auth.git"
title = "Initialise the repository"
parent = "auth"
status = "todo"
attempts = 0

[[task]]
id = "auth.later"
title = "Decide the token format"
parent = "auth"
level = "plan"
status = "todo"
attempts = 0
`);
	assert.equal(verdict.pass, true);
});

test("a title too short to stand on its own is rejected", () => {
	const verdict = round(`
[[task]]
id = "auth.x"
title = "fix it"
parent = "auth"
status = "todo"
attempts = 0
`);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /too short to stand on its own/);
});

// ------------------------------------------------------- research allowance

const RESEARCH_ONLY = `
[[task]]
id = "auth.read"
title = "Find out how the session store works"
parent = "auth"
kind = "research"
status = "todo"
attempts = 0
`;

test("research satisfies the progress rule while the branch has allowance", () => {
	const verdict = round(RESEARCH_ONLY);
	assert.equal(verdict.pass, true);
	assert.equal(verdict.spentResearch, true, "the round is charged to the allowance");
});

test("research stops satisfying it once the allowance is spent", () => {
	// An escape valve that never closes is not an escape valve, it is a bypass.
	const store = withRound(RESEARCH_ONLY);
	findTask(store, "auth")!.research_budget = 0;
	const verdict = checkPlanRound(store, findTask(store, "auth")!, [], config);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /used its research allowance/);
	assert.match(verdict.reason, /needs an act that writes to the repository/);
});

test("a spent allowance still accepts a round that writes something", () => {
	const store = withRound(`${RESEARCH_ONLY}
[[task]]
id = "auth.git"
title = "Initialise the repository"
parent = "auth"
status = "todo"
attempts = 0
`);
	findTask(store, "auth")!.research_budget = 0;
	const verdict = checkPlanRound(store, findTask(store, "auth")!, [], config);
	assert.equal(verdict.pass, true);
	assert.equal(verdict.spentResearch, false, "a round with real output does not touch the allowance");
});

test("a fresh branch falls back to the configured allowance", () => {
	const store = withRound("");
	assert.equal(researchBudgetOf(findTask(store, "auth")!, config.plan.research_budget), 2);
	const stated = createTask(store, { id: "x", title: "A sub plan here", level: "plan", research_budget: 1 });
	assert.equal(stated.research_budget, 1);
});

// -------------------------------------------------------------- depth cap

test("a plan past the nesting cap is rejected; an act at the same depth is not", () => {
	const shallow: Config = { ...config, plan: { ...config.plan, max_depth: 1 } };
	const asPlan = round(
		`
[[task]]
id = "auth.deeper"
title = "Decide the token format"
parent = "auth"
level = "plan"
status = "todo"
attempts = 0

[[task]]
id = "auth.git"
title = "Initialise the repository"
parent = "auth"
status = "todo"
attempts = 0
`,
		[],
		shallow,
	);
	assert.equal(asPlan.pass, false);
	assert.match(asPlan.reason, /past the 1 cap/);

	// Recursion without work is what has to stop; work never does.
	assert.equal(round(ONE_ACT, [], shallow).pass, true);
});

// -------------------------------------------------------------- promotion

test("an act that proved too big becomes a plan", () => {
	const store = parseStore(`
[[task]]
id = "big"
title = "Do far too much at once"
status = "todo"
attempts = 2
overflowed = true
overflow_reason = "touched 14 files"
`);
	const task = findTask(store, "big")!;
	task.rejections = ["nope"];
	promoteToPlan(store, task, "Promoted to plan: touched 14 files");
	assert.equal(levelOf(task), "plan");
	assert.equal(assignmentFor(task), "plan");
	assert.equal(task.attempts, 0);
	assert.equal(task.rejections, undefined);
});

test("a level word the loop does not own is read as a plan and written back verbatim", () => {
	// The project schema states the level on every row, and that file belongs to
	// someone else. Translating "epic" into "plan" on the way in is right;
	// rewriting their file to say so is editing data we were passing through.
	const text = `schema_version = 1

[[task]]
id = "auth"
title = "Rebuild authentication"
status = "active"
level = "epic"
category = "feature"
urgency = "high"
order = 10
tags = []
`;
	const store = parseStore(text);
	assert.equal(levelOf(findTask(store, "auth")!), "plan");
	assert.equal(serializeStore(store), text);

	// Until the loop changes it on purpose, at which point it is ours.
	promoteToPlan(store, findTask(store, "auth")!, "over budget");
	assert.match(serializeStore(store), /level = "plan"/);
});

test("a plan that closed is not still labelled unplanned", () => {
	const store = parseStore(`
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "plan"
status = "done"
attempts = 0
`);
	assert.doesNotMatch(renderTree(store), /not yet planned/);
});

test("title similarity reads through case and punctuation", () => {
	// The pair that matters is a retry restating its own earlier title in
	// different clothes. Compared raw, "ROTATE THE SIGNING SECRETS." shares
	// almost no character bigram with the lowercase original and the repeat
	// goes unnoticed.
	const same = titleSimilarity("Rotate the signing secrets", "ROTATE THE SIGNING SECRETS.");
	assert.ok(same > 0.95, `normalised titles should read as one: ${same}`);
	assert.ok(titleSimilarity("Wire the enable switch", "Rotate the signing secrets") < 0.5);
});

test("the sibling reported is the closest one, not merely the first over the line", () => {
	// A round adding a third variation has two candidates over the threshold.
	// Naming the weaker match sends the worker to look at the wrong row, and
	// it is the closer one that tells it what it already did.
	const siblings = [
		{ id: "a.loose", title: "Rotate the signing secrets for staging", status: "todo" },
		{ id: "a.exact", title: "Rotate the signing secrets", status: "done" },
	] as unknown as Parameters<typeof nearDuplicate>[1];

	const hit = nearDuplicate("Rotate the signing secrets", siblings);
	assert.equal(hit?.task.id, "a.exact");
	assert.equal(hit?.score, 1);
});
