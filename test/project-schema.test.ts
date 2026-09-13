import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	archivePathFor,
	childrenOf,
	findTask,
	loadStore,
	markDone,
	needsBreakdown,
	nextLeaf,
	parseStore,
	resolveStorePath,
	saveStore,
	serializeArchive,
	serializeStore,
	workingOrder,
} from "../src/store.ts";
import { detectSchema, NATIVE_SCHEMA, PROJECT_SCHEMA, urgencyRank } from "../src/schema.ts";
import { parseToml } from "../src/toml.ts";
import { sidecarPathFor } from "../src/sidecar.ts";

const TODO = `# TODO — active task list for this project.
#
# Single source of truth for active work.

schema_version = 1

[meta]
title = "TODO"
kind = "todo"
archive = "FINISHED.toml"

[meta.rules]
scope = "One plane, lines/arcs/circles, extrude."

[[task]]
id = "parity"
title = "Feature parity"
description = """
Long-form prose the worker actually needs.

It runs to more than one paragraph, which is why it is written this way."""
status = "active"
level = "epic"
category = "feature"
urgency = "high"
order = 10
created = 2026-09-12
tags = []

[[task]]
id = "later"
title = "Low priority scope"
description = "Do this eventually."
status = "active"
level = "scope"
parent = "parity"
category = "feature"
urgency = "low"
order = 20
created = 2026-09-12
tags = []

[[task]]
id = "urgent"
title = "Urgent child"
description = "Do this first."
status = "active"
level = "task"
parent = "parity"
category = "bug"
urgency = "critical"
order = 300
created = 2026-09-12
tags = ["ui"]
`;

const FINISHED = `# FINISHED — completed-work archive.

schema_version = 1

[meta]
title = "Finished"
kind = "finished"

[[task]]
id = "shipped"
title = "Already shipped"
description = "Done last week."
status = "finished"
level = "task"
parent = "later"
category = "feature"
created = 2026-09-11
completed = 2026-09-12
tags = []
`;

function projectStore() {
	return parseStore(TODO, { archiveText: FINISHED, archiveFile: "FINISHED.toml" });
}

test("detects the project schema from its own markers", () => {
	assert.equal(detectSchema(parseToml(TODO)), PROJECT_SCHEMA);
	assert.equal(detectSchema(parseToml(FINISHED)), PROJECT_SCHEMA);
	assert.equal(detectSchema(parseToml(`[[task]]\nid = "a"\ntitle = "A"\nstatus = "todo"\n`)), NATIVE_SCHEMA);
});

test("reads the project's prose field as the task's detail", () => {
	const store = projectStore();
	assert.match(findTask(store, "parity")?.detail ?? "", /^Long-form prose the worker actually needs\.\n/);
	assert.equal(findTask(store, "urgent")?.detail, "Do this first.");
});

test("maps the project's status words onto the loop's", () => {
	const store = projectStore();
	assert.equal(findTask(store, "parity")?.status, "todo");
	assert.equal(findTask(store, "shipped")?.status, "done");
});

test("round-trips a project queue and its archive byte for byte", () => {
	const store = projectStore();
	assert.equal(serializeStore(store), TODO);
	assert.equal(serializeArchive(store), FINISHED);
});

test("keeps fields the loop has no opinion about", () => {
	const store = projectStore();
	const urgent = findTask(store, "urgent");
	assert.equal(urgent?.extra?.category, "bug");
	assert.deepEqual(urgent?.extra?.tags, ["ui"]);
	// A date stays a date: quoting it would change its type for the other CLI.
	assert.match(serializeStore(store), /^created = 2026-09-12$/m);
});

test("works the most urgent leaf, not the first one in the file", () => {
	const store = projectStore();
	// `later` is earlier in the file and has a lower `order`, but `urgent` is
	// critical and urgency outranks both.
	assert.equal(nextLeaf(store)?.id, "urgent");
	assert.deepEqual(
		workingOrder(store).map((task) => task.id),
		["parity", "urgent", "later", "shipped"],
	);
});

test("urgency ranks the way the project CLI ranks it", () => {
	assert.ok(urgencyRank("critical") > urgencyRank("high"));
	assert.ok(urgencyRank("low") > urgencyRank("nonsense"));
});

test("archived work still counts as a breakdown", () => {
	const store = projectStore();
	const later = findTask(store, "later");
	assert.ok(later);
	// `later` is a scope whose only child has already shipped. Without the
	// archive it looks like nobody ever broke it down, and the loop scopes it
	// a second time into duplicate children.
	assert.equal(childrenOf("later", store.tasks).length, 1);
	assert.equal(needsBreakdown(later, store.tasks), false);
});

test("finishing a task moves it to the archive the way the project CLI does", () => {
	const store = projectStore();
	const urgent = findTask(store, "urgent");
	assert.ok(urgent);
	markDone(store, urgent, "shipped it");

	const active = serializeStore(store);
	assert.ok(!active.includes('id = "urgent"'), "the finished task left the active file");

	const archive = serializeArchive(store) ?? "";
	assert.match(archive, /id = "urgent"/);
	assert.match(archive, /status = "finished"/);
	assert.match(archive, /^completed = \d{4}-\d{2}-\d{2}$/m);
	// Ranking fields rank active work and are dropped on the way out; parent and
	// tags survive, because what a scope delivered is the archive's whole job.
	const block = archive.slice(archive.indexOf('id = "urgent"'));
	assert.ok(!/^urgency = /m.test(block.split("[[task]]")[0]));
	assert.ok(!/^order = /m.test(block.split("[[task]]")[0]));
	assert.match(block, /parent = "parity"/);
	// Newest first.
	assert.ok(archive.indexOf('id = "urgent"') < archive.indexOf('id = "shipped"'));
});

test("the archive path comes from the queue's own header", () => {
	assert.equal(archivePathFor("/q/TODO.toml", parseToml(TODO)), "/q/FINISHED.toml");
	assert.equal(archivePathFor("/q/TODO.toml", parseToml(TODO), "OTHER.toml"), "/q/OTHER.toml");
	assert.equal(archivePathFor("/q/todo.toml", {}), "/q/FINISHED.toml");
});

function scratch(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todoloop-project-"));
	fs.writeFileSync(path.join(dir, "TODO.toml"), TODO);
	fs.writeFileSync(path.join(dir, "FINISHED.toml"), FINISHED);
	return dir;
}

test("an existing TODO.toml is adopted rather than shadowed", () => {
	const dir = scratch();
	assert.equal(resolveStorePath(dir), path.join(dir, "TODO.toml"));
	// Nothing there: the loop's own default, so `todo init` still has a target.
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "todoloop-empty-"));
	assert.equal(resolveStorePath(empty), path.join(empty, "todo.toml"));
});

test("bookkeeping goes to the sidecar and never into the project's file", () => {
	const dir = scratch();
	const file = path.join(dir, "TODO.toml");
	const store = loadStore(file);
	const urgent = findTask(store, "urgent");
	assert.ok(urgent);
	urgent.attempts = 2;
	urgent.reason = "the route is never registered";
	store.loop.running = true;
	store.loop.current = "urgent";
	saveStore(file, store);

	const written = fs.readFileSync(file, "utf8");
	assert.ok(!written.includes("attempts"), "attempts stayed out of the task file");
	assert.ok(!written.includes("[loop]"), "loop state stayed out of the task file");
	assert.equal(written, TODO, "the queue is untouched by work that is not the queue's");

	const sidecar = fs.readFileSync(sidecarPathFor(file), "utf8");
	assert.match(sidecar, /attempts = 2/);

	const reloaded = loadStore(file);
	assert.equal(findTask(reloaded, "urgent")?.attempts, 2);
	assert.equal(findTask(reloaded, "urgent")?.reason, "the route is never registered");
	assert.equal(reloaded.loop.current, "urgent");
	assert.equal(reloaded.loop.running, true);
});

test("saving writes both files", () => {
	const dir = scratch();
	const file = path.join(dir, "TODO.toml");
	const store = loadStore(file);
	const urgent = findTask(store, "urgent");
	assert.ok(urgent);
	markDone(store, urgent, "shipped it");
	saveStore(file, store);

	assert.ok(!fs.readFileSync(file, "utf8").includes('id = "urgent"'));
	assert.match(fs.readFileSync(path.join(dir, "FINISHED.toml"), "utf8"), /id = "urgent"/);
});
