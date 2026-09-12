import assert from "node:assert/strict";
import { test } from "node:test";
import { auditQueue, formatChecks, type Check } from "../src/doctor.ts";
import { parseStore } from "../src/store.ts";

function levelOf(checks: Check[], label: string): string | undefined {
	return checks.find((check) => check.label === label)?.level;
}

test("a healthy queue reports only the summary", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "api"
title = "Build the health API"
[[task]]
id = "api.route"
title = "Add GET /health returning 200"
`),
	);
	assert.equal(checks.length, 1);
	assert.equal(levelOf(checks, "queue"), "ok");
	assert.match(checks[0].detail, /2 tasks, 1 leaves.*next is api\.route/);
});

test("duplicate ids are a blocking problem", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "a"
title = "First definition"
[[task]]
id = "a"
title = "Second definition"
`),
	);
	assert.equal(levelOf(checks, "duplicate ids"), "fail");
});

test("a parent that does not exist is a blocking problem", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "orphan"
parent = "nowhere"
title = "Task with a missing parent"
`),
	);
	assert.equal(levelOf(checks, "missing parents"), "fail");
});

test("cyclic parents are caught rather than hung on", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "a"
parent = "b"
title = "First task"
[[task]]
id = "b"
parent = "a"
title = "Second task"
`),
	);
	assert.equal(levelOf(checks, "cyclic parents"), "fail");
});

test("detail on a non-leaf is flagged because it is never shown", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "api"
title = "Build the API"
detail = "This text never reaches a model."
[[task]]
id = "api.route"
title = "Add GET /health returning 200"
`),
	);
	assert.equal(levelOf(checks, "detail on non-leaf tasks"), "warn");
});

test("an exhausted queue is a warning, not a pass", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "a"
title = "Already finished work"
status = "done"
`),
	);
	assert.equal(levelOf(checks, "queue"), "warn");
	assert.match(checks[0].detail, /nothing runnable/);
	assert.match(checks[0].detail, /1 task,/);
});

test("formatting marks each level", () => {
	const text = formatChecks([
		{ level: "ok", label: "a", detail: "fine" },
		{ level: "warn", label: "b", detail: "hmm" },
		{ level: "fail", label: "c", detail: "no" },
	]);
	assert.equal(text, "✓ a: fine\n! b: hmm\n✗ c: no");
});
