import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToml, stringifyToml } from "../src/toml.ts";

const sample = `
# leading comment
[loop]
running = true
iterations = 3
threshold = 0.6

[[task]]
id = "setup"
title = "Do \\"quoted\\" work"
tags = ["one", "two"]
detail = """
line one
line two
"""

[[task]]
id = "setup.sub"
title = 'literal # not a comment'
attempts = 0
`;

test("parses tables, arrays of tables and scalars", () => {
	const doc = parseToml(sample);
	const loop = doc.loop as Record<string, unknown>;
	assert.equal(loop.running, true);
	assert.equal(loop.iterations, 3);
	assert.equal(loop.threshold, 0.6);

	const tasks = doc.task as Record<string, unknown>[];
	assert.equal(tasks.length, 2);
	assert.equal(tasks[0].title, 'Do "quoted" work');
	assert.deepEqual(tasks[0].tags, ["one", "two"]);
	assert.equal(tasks[0].detail, "line one\nline two\n");
	assert.equal(tasks[1].title, "literal # not a comment");
	assert.equal(tasks[1].attempts, 0);
});

test("round-trips through stringify", () => {
	const doc = parseToml(sample);
	const again = parseToml(stringifyToml(doc));
	assert.deepEqual(again, doc);
});

test("ignores comments and blank lines", () => {
	const doc = parseToml("# only a comment\n\n  \n");
	assert.deepEqual(doc, {});
});

test("reports line numbers on malformed input", () => {
	assert.throws(() => parseToml("[a]\nkey\n"), /line 2/);
});
