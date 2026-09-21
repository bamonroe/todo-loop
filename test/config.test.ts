import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyWorkerOverride,
	childEnv,
	DEFAULT_CONFIG,
	isLocalRef,
	parseConfig,
	reservedEnv,
	splitModelRef,
	withWorkerOverride,
} from "../src/config.ts";

test("no flags leave the configured worker alone", () => {
	assert.equal(applyWorkerOverride("ollama/qwen3.8-27b", undefined, undefined), "ollama/qwen3.8-27b");
	assert.equal(applyWorkerOverride("inherit", "", ""), "inherit");
});

test("a fully qualified --model decides both halves", () => {
	assert.equal(applyWorkerOverride("ollama/qwen3.8-27b", undefined, "openai-codex/gpt-5.6-terra"), "openai-codex/gpt-5.6-terra");
	// An explicit prefix on --model wins over --provider rather than producing a
	// reference that mixes the two.
	assert.equal(applyWorkerOverride("inherit", "ollama", "openai-codex/gpt-5.6-terra"), "openai-codex/gpt-5.6-terra");
});

test("half an override keeps the other half from the config", () => {
	assert.equal(applyWorkerOverride("openai-codex/gpt-5.6-terra", undefined, "gpt-5.6-luna"), "openai-codex/gpt-5.6-luna");
	assert.equal(applyWorkerOverride("openai-codex/gpt-5.6-terra", "ollama", undefined), "ollama/gpt-5.6-terra");
});

test("overriding half of an inherited worker falls back to the built-in default", () => {
	// "inherit" names no provider and no model, so there is nothing to merge into.
	const { provider, model } = splitModelRef(DEFAULT_CONFIG.models.worker);
	assert.equal(applyWorkerOverride("inherit", undefined, "gpt-5.6-luna"), `${provider}/gpt-5.6-luna`);
	assert.equal(applyWorkerOverride("inherit", "ollama", undefined), `ollama/${model}`);
});

test("withWorkerOverride returns the original config when nothing changed", () => {
	const config = parseConfig('[models]\nworker = "ollama/qwen3.8-27b"\n');
	assert.equal(withWorkerOverride(config, undefined, undefined), config);
	const overridden = withWorkerOverride(config, undefined, "gpt-5.6-terra");
	assert.equal(overridden.models.worker, "ollama/gpt-5.6-terra");
	// The untouched halves come along, and the original is not mutated.
	assert.equal(overridden.models.verifier, config.models.verifier);
	assert.equal(config.models.worker, "ollama/qwen3.8-27b");
});

test("a bare reference is an ollama tag, a prefixed one is not", () => {
	assert.equal(isLocalRef("qwen3.8-27b:52k"), true);
	assert.equal(isLocalRef("ollama/qwen3.8-27b"), true);
	assert.equal(isLocalRef("openai-codex/gpt-5.6-terra"), false);
});

test("worker_timeout_ms parses and defaults to no cap", () => {
	assert.equal(parseConfig("").loop.worker_timeout_ms, 0);
	assert.equal(parseConfig("[loop]\nworker_timeout_ms = 1800000\n").loop.worker_timeout_ms, 1800000);
	// A negative budget would kill the worker on the first tick.
	assert.equal(parseConfig("[loop]\nworker_timeout_ms = -5\n").loop.worker_timeout_ms, 0);
});

test("the breakdown gets its own budget, separate from a worker's", () => {
	assert.equal(parseConfig("").loop.plan_timeout_ms, 0);
	const config = parseConfig("[loop]\nworker_timeout_ms = 900000\nplan_timeout_ms = 900000\n");
	assert.equal(config.loop.plan_timeout_ms, 900000);
	assert.equal(config.loop.worker_timeout_ms, 900000);
});

test("the old decompose_timeout_ms is still honoured", () => {
	// Renamed with the levels. A todoloop.toml that still says it must not
	// silently lose its budget and start running unbounded planning sessions.
	assert.equal(parseConfig("[loop]\ndecompose_timeout_ms = 900000\n").loop.plan_timeout_ms, 900000);
	// The new name wins where both are present.
	assert.equal(
		parseConfig("[loop]\ndecompose_timeout_ms = 900000\nplan_timeout_ms = 60000\n").loop.plan_timeout_ms,
		60000,
	);
});

test("the plan section has defaults and reads overrides", () => {
	const fresh = parseConfig("").plan;
	assert.equal(fresh.max_children, 5);
	assert.equal(fresh.research_budget, 2);
	assert.equal(fresh.max_depth, 8);
	assert.equal(fresh.memory_file, "NOTES.md");

	const tuned = parseConfig("[plan]\nmax_children = 3\nresearch_budget = 0\nmemory_file = \"docs/notes.md\"\n").plan;
	assert.equal(tuned.max_children, 3);
	assert.equal(tuned.research_budget, 0, "zero is a real setting: no research rounds at all");
	assert.equal(tuned.memory_file, "docs/notes.md");
});

test("the env table is read as written", () => {
	assert.deepEqual(parseConfig("").env, {}, "no table is no variables, not a default set");

	const env = parseConfig(
		['[env]', 'PI_ANDROID_PROJECT = "/data/eq2"', "PORT = 8080", "STRICT = true", 'EMPTY = ""'].join("\n"),
	).env;
	assert.equal(env.PI_ANDROID_PROJECT, "/data/eq2");
	assert.equal(env.PORT, "8080", "a number arrives as its digits");
	assert.equal(env.STRICT, "true", "a boolean is rendered, not interpreted — guessing at \"1\" would change what the file says");
	assert.equal(env.EMPTY, "", "empty is a real value: it is how you unset something the ambient shell exported");
});

test("an env value with no environment representation is dropped rather than mangled", () => {
	const env = parseConfig('[env]\nGOOD = "yes"\nLIST = ["a", "b"]\n').env;
	assert.equal(env.GOOD, "yes");
	assert.ok(!("LIST" in env), "an array is not a variable");
});

test("childEnv layers the ambient shell, the project and the caller in that order", () => {
	const config = parseConfig('[env]\nTODOLOOP_TEST_ONE = "project"\nTODOLOOP_TEST_TWO = "project"\n');
	process.env.TODOLOOP_TEST_ONE = "ambient";
	process.env.TODOLOOP_TEST_THREE = "ambient";
	try {
		const result = childEnv(config, { TODOLOOP_TEST_TWO: "caller" });
		assert.equal(result.TODOLOOP_TEST_ONE, "project", "the file beats the shell — that is the point of declaring it");
		assert.equal(result.TODOLOOP_TEST_TWO, "caller", "the caller beats the file");
		assert.equal(result.TODOLOOP_TEST_THREE, "ambient", "and everything else is inherited");
	} finally {
		delete process.env.TODOLOOP_TEST_ONE;
		delete process.env.TODOLOOP_TEST_THREE;
	}
});

test("a project cannot set the driver's own variables, even the ones no caller overrides", () => {
	// TODOLOOP_CONFIG is the dangerous one: nothing passes it at a spawn site,
	// so layering order alone would let a project choose which config file its
	// own children read.
	const config = parseConfig(
		['[env]', 'TODOLOOP_DRIVER = "session"', 'TODOLOOP_CONFIG = "other.toml"', 'KEPT = "yes"'].join("\n"),
	);
	assert.deepEqual(reservedEnv(config), ["TODOLOOP_DRIVER", "TODOLOOP_CONFIG"], "reported so doctor can say so");

	const result = childEnv(config, { TODOLOOP_DRIVER: "shell" });
	assert.equal(result.TODOLOOP_DRIVER, "shell");
	assert.equal(result.TODOLOOP_CONFIG, undefined, "dropped, not merely outranked");
	assert.equal(result.KEPT, "yes", "and the rest of the table still applies");
});
