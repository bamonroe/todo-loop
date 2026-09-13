import assert from "node:assert/strict";
import { test } from "node:test";
import { isRaw, leadingComments, parseToml, stringifyToml, todayRaw } from "../src/toml.ts";

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

test("carries a bare date through unchanged", () => {
	const doc = parseToml("created = 2026-09-12\n");
	assert.ok(isRaw(doc.created), "a date is not a string and must not become one");
	assert.equal(stringifyToml(doc), "created = 2026-09-12\n");
});

test("today is written in the same bare form", () => {
	assert.equal(todayRaw(new Date(2026, 8, 5)).token, "2026-09-05");
});

test("a multi-line string keeps its newlines and breaks up a stray triple quote", () => {
	const text = 'body = """\nfirst\n\nsecond"""\n';
	const doc = parseToml(text);
	assert.equal(doc.body, "first\n\nsecond");
	assert.equal(stringifyToml(doc), text);
	// Only the multi-line form can be ended early by a stray triple quote; a
	// single-line string escapes each quote anyway.
	const risky = stringifyToml({ body: 'a\n""" b' });
	assert.match(risky, /""\\"/);
	assert.equal(parseToml(risky).body, 'a\n""" b');
});

test("lifts the leading comment block out so a write can put it back", () => {
	assert.equal(leadingComments("# one\n# two\n\nkey = 1\n"), "# one\n# two");
	assert.equal(leadingComments("key = 1\n# not leading\n"), "");
});
