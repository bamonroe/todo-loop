import assert from "node:assert/strict";
import { test } from "node:test";
import { ancestryOf, renderPinnedTask, renderTaskPrompt } from "../src/prompt.ts";
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
	assert.match(pinned, /api\.health: Add a health endpoint/);
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
